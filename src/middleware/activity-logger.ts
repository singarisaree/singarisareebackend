import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from './auth';
import { prisma } from '@/config/database';
import { ActivityAction } from '@prisma/client';

export function activityLogger(entity: string, action: ActivityAction) {
  return async (
    req: AuthenticatedRequest,
    _res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      await prisma.activityLog.create({
        data: {
          adminId: req.admin?.id,
          action,
          entity,
          entityId: typeof req.params.id === 'string' ? req.params.id : req.params.id?.[0],
          details: {
            method: req.method,
            path: req.path,
            body: req.method !== 'GET' ? req.body : undefined,
          },
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'],
        },
      });
    } catch {
      // Non-blocking audit log
    }
    next();
  };
}
