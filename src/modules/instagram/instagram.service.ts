import { prisma } from '@/config/database';
import { ApiError } from '@/shared/api-response';
import { localStorageService } from '@/integrations/local-storage.service';
import { MAX_INSTAGRAM_REELS } from './instagram.schema';

/** Canonical permalink Instagram embed.js expects. */
export function normalizeInstagramPermalink(raw: string): string {
  const url = new URL(raw.trim());
  const path = url.pathname.replace(/\/+$/, '') + '/';
  return `https://www.instagram.com${path}`;
}

export class InstagramService {
  async findActive() {
    return prisma.instagramFeed.findMany({
      where: { isActive: true, deletedAt: null },
      orderBy: { sortOrder: 'asc' },
    });
  }

  async findAll() {
    return prisma.instagramFeed.findMany({
      where: { deletedAt: null },
      orderBy: { sortOrder: 'asc' },
    });
  }

  async create(data: { caption?: string; linkUrl?: string; sortOrder?: number }, file: Express.Multer.File) {
    const upload = await localStorageService.uploadImage(file.buffer, 'instagram');
    return prisma.instagramFeed.create({
      data: {
        ...data,
        imageUrl: upload.url,
        publicId: upload.publicId,
      },
    });
  }

  async update(id: string, data: Record<string, unknown>) {
    const feed = await prisma.instagramFeed.findFirst({ where: { id, deletedAt: null } });
    if (!feed) throw new ApiError(404, 'Instagram feed not found');
    return prisma.instagramFeed.update({
      where: { id },
      data: data as Parameters<typeof prisma.instagramFeed.update>[0]['data'],
    });
  }

  async softDelete(id: string) {
    const feed = await prisma.instagramFeed.findFirst({ where: { id, deletedAt: null } });
    if (!feed) throw new ApiError(404, 'Instagram feed not found');
    await localStorageService.deleteImage(feed.publicId);
    await prisma.instagramFeed.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
  }

  async findActiveReels() {
    return prisma.instagramReel.findMany({
      where: { isActive: true, deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        videoUrl: true,
        sortOrder: true,
      },
    });
  }

  async findAllReels() {
    return prisma.instagramReel.findMany({
      where: { deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async createReel(data: { videoUrl: string; sortOrder?: number; isActive?: boolean }) {
    const videoUrl = normalizeInstagramPermalink(data.videoUrl);

    return prisma.$transaction(async (tx) => {
      const activeCount = await tx.instagramReel.count({
        where: { deletedAt: null },
      });

      // Cap at 10: remove the oldest (not the new one).
      if (activeCount >= MAX_INSTAGRAM_REELS) {
        const oldest = await tx.instagramReel.findFirst({
          where: { deletedAt: null },
          orderBy: [{ createdAt: 'asc' }, { sortOrder: 'asc' }],
          select: { id: true },
        });
        if (oldest) {
          await tx.instagramReel.update({
            where: { id: oldest.id },
            data: { deletedAt: new Date(), isActive: false },
          });
        }
      }

      const maxSort = await tx.instagramReel.aggregate({
        where: { deletedAt: null },
        _max: { sortOrder: true },
      });

      return tx.instagramReel.create({
        data: {
          videoUrl,
          sortOrder:
            data.sortOrder ?? (maxSort._max.sortOrder == null ? 0 : maxSort._max.sortOrder + 1),
          isActive: data.isActive ?? true,
        },
      });
    });
  }

  async updateReel(
    id: string,
    data: { videoUrl?: string; sortOrder?: number; isActive?: boolean },
  ) {
    const reel = await prisma.instagramReel.findFirst({ where: { id, deletedAt: null } });
    if (!reel) throw new ApiError(404, 'Instagram video not found');

    return prisma.instagramReel.update({
      where: { id },
      data: {
        ...(data.videoUrl !== undefined
          ? { videoUrl: normalizeInstagramPermalink(data.videoUrl) }
          : {}),
        ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
      },
    });
  }

  async reorderReels(orderedIds: string[]) {
    const existing = await prisma.instagramReel.findMany({
      where: { id: { in: orderedIds }, deletedAt: null },
      select: { id: true },
    });
    if (existing.length !== orderedIds.length) {
      throw new ApiError(400, 'One or more Instagram videos were not found');
    }

    await prisma.$transaction(
      orderedIds.map((id, index) =>
        prisma.instagramReel.update({
          where: { id },
          data: { sortOrder: index },
        }),
      ),
    );

    return this.findAllReels();
  }

  async softDeleteReel(id: string) {
    const reel = await prisma.instagramReel.findFirst({ where: { id, deletedAt: null } });
    if (!reel) throw new ApiError(404, 'Instagram video not found');
    await prisma.instagramReel.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
  }
}

export const instagramService = new InstagramService();
