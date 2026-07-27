import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { spawn } from 'child_process';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import ffmpegStatic from 'ffmpeg-static';
import { apiBaseUrl } from '@/config/env';
import { ApiError } from '@/shared/api-response';
import { logger } from '@/utils/logger';

/**
 * Result of persisting an image to local disk.
 * `url` and `publicId` both hold the relative path (e.g. "/uploads/products/<uuid>.webp").
 * The `url`/`publicId` shape is kept so image-consuming callers stay unchanged.
 */
export interface StoredImage {
  url: string;
  publicId: string;
  width: number;
  height: number;
}

export interface StoredVideo {
  url: string;
  publicId: string;
  byteSize: number;
}

/** All WebP output is compressed at this quality. */
const WEBP_QUALITY = 80;

/** Target max bytes after conversion (~8 MB compressed reel). */
const MAX_REEL_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Public URL prefix images are served under (see express.static in app.ts). */
const PUBLIC_PREFIX = '/uploads';

/** Absolute path to the uploads root on disk. */
export const UPLOADS_DIR = path.resolve(process.cwd(), 'uploads');

/**
 * Max width (px) applied per image category. Aspect ratio is preserved and images
 * are never enlarged beyond their original size.
 */
const CATEGORY_MAX_WIDTH: Record<string, number> = {
  products: 1200,
  banners: 1920,
  categories: 800,
  testimonials: 600,
  instagram: 1080,
  'instagram-reels': 1080,
  marketing: 1080,
  'our-story': 1400,
  'invoice-signature': 600,
  'return-requests': 1200,
  'whatsapp-template-samples': 1080,
};

const DEFAULT_MAX_WIDTH = 1200;

/** Legacy folder names mapped onto the local folder taxonomy. */
const FOLDER_ALIASES: Record<string, string> = {
  'hero-banners': 'banners',
  'hero-banners/mobile': 'banners',
  reviews: 'testimonials',
};

/** All folders eagerly created on boot. */
export const IMAGE_CATEGORIES = Object.keys(CATEGORY_MAX_WIDTH);

/**
 * Normalise an incoming folder hint (which may be a nested path)
 * into a single flat category folder under uploads/.
 */
function resolveCategory(folder: string): string {
  const normalized = folder.trim().replace(/^\/+|\/+$/g, '');
  if (normalized.startsWith('products')) return 'products';
  if (FOLDER_ALIASES[normalized]) return FOLDER_ALIASES[normalized];
  return normalized.split('/')[0] || 'misc';
}

export class LocalStorageService {
  /** Create every category folder up front so writes never fail on a missing directory. */
  async ensureBaseFolders(): Promise<void> {
    await Promise.all(
      IMAGE_CATEGORIES.map((category) =>
        fs.mkdir(path.join(UPLOADS_DIR, category), { recursive: true }),
      ),
    );
  }

  /**
   * Convert to WebP, compress, resize by category, and persist under a unique filename.
   * Returns the relative path to store in the database and return via the API.
   */
  async uploadImage(buffer: Buffer, folder: string): Promise<StoredImage> {
    const category = resolveCategory(folder);
    const maxWidth = CATEGORY_MAX_WIDTH[category] ?? DEFAULT_MAX_WIDTH;
    const dir = path.join(UPLOADS_DIR, category);
    const filename = `${randomUUID()}.webp`;

    try {
      await fs.mkdir(dir, { recursive: true });

      const { data, info } = await sharp(buffer)
        .rotate()
        .resize({ width: maxWidth, withoutEnlargement: true, fit: 'inside' })
        .webp({ quality: WEBP_QUALITY })
        .toBuffer({ resolveWithObject: true });

      await fs.writeFile(path.join(dir, filename), data);

      const relativePath = `${PUBLIC_PREFIX}/${category}/${filename}`;
      return {
        url: relativePath,
        publicId: relativePath,
        width: info.width,
        height: info.height,
      };
    } catch (error) {
      logger.error('Local image upload failed', {
        folder,
        error: error instanceof Error ? error.message : 'Unknown',
      });
      throw new ApiError(500, 'Image upload failed');
    }
  }

  /** Persist several images in parallel. */
  async uploadMultiple(
    files: Express.Multer.File[],
    folder: string,
  ): Promise<StoredImage[]> {
    return Promise.all(files.map((file) => this.uploadImage(file.buffer, folder)));
  }

  /**
   * Convert uploaded video to H.264 MP4 (max ~720p), compress, and store under
   * uploads/instagram-reels/. Falls back to original only for MP4/WebM if ffmpeg fails.
   * MOV always requires a successful conversion (browsers cannot play raw MOV reliably).
   */
  async uploadVideo(
    buffer: Buffer,
    originalMime?: string,
    originalName?: string,
    storageFolder = 'instagram-reels',
  ): Promise<StoredVideo> {
    const category = storageFolder;
    const dir = path.join(UPLOADS_DIR, category);
    await fs.mkdir(dir, { recursive: true });

    const mime = (originalMime || '').toLowerCase();
    const name = (originalName || '').toLowerCase();
    const isMov = mime.includes('quicktime') || mime.includes('video/mov') || /\.mov$/i.test(name);
    const isWebm = mime.includes('webm') || /\.webm$/i.test(name);
    const isMp4 = mime.includes('mp4') || mime.includes('m4v') || /\.(mp4|m4v)$/i.test(name);

    let output: Buffer;
    try {
      output = await this.convertVideoToMp4(buffer, { isMov, isWebm, originalName });
    } catch (error) {
      logger.warn('ffmpeg convert failed; storing original if already web-friendly', {
        error: error instanceof Error ? error.message : error,
        mime,
        originalName,
      });
      if ((isMp4 || isWebm) && buffer.byteLength <= MAX_REEL_OUTPUT_BYTES) {
        output = buffer;
      } else if (isMp4 || isWebm) {
        throw new ApiError(
          400,
          'Could not compress this video under 8 MB. Use a shorter clip.',
        );
      } else {
        throw new ApiError(
          400,
          'Could not convert this video. Try exporting as MP4, or install/update ffmpeg on the server.',
        );
      }
    }

    if (output.byteLength > MAX_REEL_OUTPUT_BYTES) {
      throw new ApiError(
        400,
        'Video is still too large after compression (max 8 MB). Use a shorter clip.',
      );
    }

    const ext = isWebm && output === buffer ? 'webm' : 'mp4';
    const filename = `${randomUUID()}.${ext}`;
    const absolutePath = path.join(dir, filename);
    await fs.writeFile(absolutePath, output);

    const relativePath = `${PUBLIC_PREFIX}/${category}/${filename}`;
    return {
      url: relativePath,
      publicId: relativePath,
      byteSize: output.byteLength,
    };
  }

  private async convertVideoToMp4(
    input: Buffer,
    hints?: { isMov?: boolean; isWebm?: boolean; originalName?: string },
  ): Promise<Buffer> {
    const ffmpegPath = typeof ffmpegStatic === 'string' ? ffmpegStatic : null;
    if (!ffmpegPath) {
      throw new Error('ffmpeg-static binary not available');
    }

    const id = randomUUID();
    const inExt = hints?.isMov
      ? '.mov'
      : hints?.isWebm
        ? '.webm'
        : hints?.originalName && /\.[a-z0-9]+$/i.test(hints.originalName)
          ? path.extname(hints.originalName).toLowerCase()
          : '.mp4';
    const tmpIn = path.join(os.tmpdir(), `ig-reel-${id}-in${inExt}`);
    const tmpOut = path.join(os.tmpdir(), `ig-reel-${id}.mp4`);

    await fs.writeFile(tmpIn, input);

    /** Escalating compression until output fits under 8 MB. */
    const passes: Array<{ scale: string; crf: string; audio: boolean; maxSeconds: string }> = [
      { scale: "scale='min(720,iw)':-2", crf: '28', audio: true, maxSeconds: '90' },
      { scale: "scale='min(720,iw)':-2", crf: '32', audio: true, maxSeconds: '90' },
      { scale: "scale='min(540,iw)':-2", crf: '34', audio: true, maxSeconds: '60' },
      { scale: "scale='min(480,iw)':-2", crf: '36', audio: false, maxSeconds: '60' },
    ];

    const buildArgs = (pass: (typeof passes)[number], stripAudio: boolean) => {
      const args = [
        '-y',
        '-fflags',
        '+genpts',
        '-i',
        tmpIn,
        '-vf',
        pass.scale,
        '-c:v',
        'libx264',
        '-preset',
        'fast',
        '-crf',
        pass.crf,
      ];
      if (stripAudio || !pass.audio) {
        args.push('-an');
      } else {
        args.push('-c:a', 'aac', '-b:a', '64k', '-ac', '2', '-ar', '44100');
      }
      args.push(
        '-movflags',
        '+faststart',
        '-pix_fmt',
        'yuv420p',
        '-t',
        pass.maxSeconds,
        tmpOut,
      );
      return args;
    };

    try {
      let lastError: unknown;
      let best: Buffer | null = null;

      for (const pass of passes) {
        try {
          try {
            await this.runFfmpeg(ffmpegPath, buildArgs(pass, false));
          } catch (firstError) {
            if (!hints?.isMov) throw firstError;
            logger.warn('MOV convert retry without audio', {
              error: firstError instanceof Error ? firstError.message : firstError,
              crf: pass.crf,
            });
            await this.runFfmpeg(ffmpegPath, buildArgs(pass, true));
          }

          const output = await fs.readFile(tmpOut);
          if (!output.byteLength) throw new Error('ffmpeg produced empty file');

          if (!best || output.byteLength < best.byteLength) best = output;
          if (output.byteLength <= MAX_REEL_OUTPUT_BYTES) return output;

          logger.info('Reel still over 8 MB; trying stronger compression', {
            bytes: output.byteLength,
            crf: pass.crf,
            scale: pass.scale,
          });
        } catch (error) {
          lastError = error;
        }
      }

      if (best && best.byteLength <= MAX_REEL_OUTPUT_BYTES) return best;
      if (lastError) throw lastError;
      if (best) return best;
      throw new Error('ffmpeg produced empty file');
    } finally {
      await Promise.all([
        fs.unlink(tmpIn).catch(() => undefined),
        fs.unlink(tmpOut).catch(() => undefined),
      ]);
    }
  }

  private runFfmpeg(bin: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        if (stderr.length > 4000) stderr = stderr.slice(-4000);
      });
      proc.on('error', (error) => reject(error));
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
      });
    });
  }

  /** Best-effort removal of a single stored image. Missing files are ignored. */
  async deleteImage(storedPath: string | null | undefined): Promise<void> {
    const absolutePath = this.resolveStoredPath(storedPath);
    if (!absolutePath) return;

    try {
      await fs.unlink(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      logger.error('Local image delete failed', {
        storedPath,
        error: error instanceof Error ? error.message : 'Unknown',
      });
    }
  }

  /** Best-effort bulk removal. */
  async deleteMultiple(storedPaths: Array<string | null | undefined>): Promise<void> {
    if (storedPaths.length === 0) return;
    await Promise.all(storedPaths.map((storedPath) => this.deleteImage(storedPath)));
  }

  /**
   * Map a stored relative path back to a safe absolute path inside UPLOADS_DIR.
   * Returns null for empty input or any path that escapes the uploads root.
   */
  private resolveStoredPath(storedPath: string | null | undefined): string | null {
    if (!storedPath) return null;

    const markerIndex = storedPath.indexOf(`${PUBLIC_PREFIX}/`);
    const relative =
      markerIndex >= 0
        ? storedPath.slice(markerIndex + PUBLIC_PREFIX.length + 1)
        : storedPath.replace(/^\/+/, '');

    const absolutePath = path.resolve(UPLOADS_DIR, relative);
    if (absolutePath !== UPLOADS_DIR && !absolutePath.startsWith(`${UPLOADS_DIR}${path.sep}`)) {
      logger.warn('Refused to delete image outside uploads root', { storedPath });
      return null;
    }
    return absolutePath;
  }

  /**
   * Load a stored image and re-encode as JPEG for WhatsApp (WebP/GIF not supported
   * for template headers / media messages).
   */
  async readJpegForWhatsApp(
    storedPath: string,
  ): Promise<{ buffer: Buffer; mimeType: 'image/jpeg'; filename: string }> {
    const absolutePath = this.resolveStoredPath(storedPath);
    if (!absolutePath) {
      throw new ApiError(400, 'Marketing image file was not found on the server');
    }

    try {
      const buffer = await sharp(absolutePath)
        .rotate()
        .resize({ width: 1080, withoutEnlargement: true, fit: 'inside' })
        .jpeg({ quality: 85, mozjpeg: true })
        .toBuffer();

      if (buffer.byteLength > 5 * 1024 * 1024) {
        throw new ApiError(400, 'Marketing image is too large for WhatsApp (max 5 MB)');
      }

      return {
        buffer,
        mimeType: 'image/jpeg',
        filename: 'marketing.jpg',
      };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      logger.error('Failed to prepare marketing image for WhatsApp', {
        storedPath,
        error: error instanceof Error ? error.message : error,
      });
      throw new ApiError(400, 'Could not prepare marketing image for WhatsApp');
    }
  }
}

export const localStorageService = new LocalStorageService();

/**
 * Resolve a stored relative image path to an absolute, publicly reachable URL.
 * Used where an external service (e.g. WhatsApp Cloud API media) must fetch the
 * image over HTTP. Already-absolute URLs are returned untouched.
 */
export function toPublicImageUrl(storedPath: string | null | undefined): string | null {
  if (!storedPath) return null;
  if (/^https?:\/\//i.test(storedPath)) return storedPath;
  const normalized = storedPath.startsWith('/') ? storedPath : `/${storedPath}`;
  return `${apiBaseUrl.replace(/\/+$/, '')}${normalized}`;
}
