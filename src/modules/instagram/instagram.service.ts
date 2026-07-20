import { prisma } from '@/config/database';
import { ApiError } from '@/shared/api-response';
import { localStorageService } from '@/integrations/local-storage.service';

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
    return prisma.instagramFeed.update({ where: { id }, data: data as Parameters<typeof prisma.instagramFeed.update>[0]['data'] });
  }

  async softDelete(id: string) {
    const feed = await prisma.instagramFeed.findFirst({ where: { id, deletedAt: null } });
    if (!feed) throw new ApiError(404, 'Instagram feed not found');
    await localStorageService.deleteImage(feed.publicId);
    await prisma.instagramFeed.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } });
  }
}

export const instagramService = new InstagramService();
