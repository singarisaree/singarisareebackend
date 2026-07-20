import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import sharp from 'sharp';
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

/** All WebP output is compressed at this quality. */
const WEBP_QUALITY = 80;

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
