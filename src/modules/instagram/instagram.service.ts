import { prisma } from '@/config/database';
import { ApiError } from '@/shared/api-response';
import { localStorageService } from '@/integrations/local-storage.service';
import { MAX_INSTAGRAM_REELS, normalizeInstagramLink } from './instagram.schema';

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
        instagramUrl: true,
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

  async createReel(
    data: { instagramUrl: string; sortOrder?: number; isActive?: boolean },
    file: Express.Multer.File,
  ) {
    const instagramUrl = normalizeInstagramLink(data.instagramUrl);
    if (!instagramUrl) throw new ApiError(400, 'Invalid Instagram link');

    const upload = await localStorageService.uploadVideo(file.buffer, file.mimetype);
    const filesToDelete: string[] = [];

    try {
      const created = await prisma.$transaction(async (tx) => {
        const active = await tx.instagramReel.findMany({
          where: { deletedAt: null },
          orderBy: [{ createdAt: 'asc' }, { sortOrder: 'asc' }],
          select: { id: true, publicId: true },
        });

        if (active.length >= MAX_INSTAGRAM_REELS) {
          const overflow = active.length - MAX_INSTAGRAM_REELS + 1;
          for (let i = 0; i < overflow; i += 1) {
            const oldest = active[i];
            if (!oldest) break;
            await tx.instagramReel.delete({ where: { id: oldest.id } });
            filesToDelete.push(oldest.publicId);
          }
        }

        const maxSort = await tx.instagramReel.aggregate({
          where: { deletedAt: null },
          _max: { sortOrder: true },
        });

        return tx.instagramReel.create({
          data: {
            videoUrl: upload.url,
            publicId: upload.publicId,
            instagramUrl,
            sortOrder:
              data.sortOrder ?? (maxSort._max.sortOrder == null ? 0 : maxSort._max.sortOrder + 1),
            isActive: data.isActive ?? true,
          },
        });
      });

      await localStorageService.deleteMultiple(filesToDelete);
      return created;
    } catch (error) {
      await localStorageService.deleteImage(upload.publicId);
      throw error;
    }
  }

  async updateReel(
    id: string,
    data: { instagramUrl?: string; sortOrder?: number; isActive?: boolean },
    file?: Express.Multer.File,
  ) {
    const reel = await prisma.instagramReel.findFirst({ where: { id, deletedAt: null } });
    if (!reel) throw new ApiError(404, 'Instagram video not found');

    let upload: { url: string; publicId: string } | null = null;
    if (file) {
      upload = await localStorageService.uploadVideo(file.buffer, file.mimetype);
    }

    let nextInstagramUrl: string | undefined;
    if (data.instagramUrl !== undefined) {
      const normalized = normalizeInstagramLink(data.instagramUrl);
      if (!normalized) {
        if (upload) await localStorageService.deleteImage(upload.publicId);
        throw new ApiError(400, 'Invalid Instagram link');
      }
      nextInstagramUrl = normalized;
    }

    try {
      const updated = await prisma.instagramReel.update({
        where: { id },
        data: {
          ...(upload
            ? { videoUrl: upload.url, publicId: upload.publicId }
            : {}),
          ...(nextInstagramUrl !== undefined ? { instagramUrl: nextInstagramUrl } : {}),
          ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}),
          ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        },
      });

      if (upload) {
        await localStorageService.deleteImage(reel.publicId);
      }
      return updated;
    } catch (error) {
      if (upload) await localStorageService.deleteImage(upload.publicId);
      throw error;
    }
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

  async deleteReel(id: string) {
    const reel = await prisma.instagramReel.findFirst({ where: { id, deletedAt: null } });
    if (!reel) throw new ApiError(404, 'Instagram video not found');
    await prisma.instagramReel.delete({ where: { id } });
    await localStorageService.deleteImage(reel.publicId);
  }
}

export const instagramService = new InstagramService();
