import { Request, Response, NextFunction } from 'express';

export function publicCache(maxAgeSeconds: number) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.set(
      'Cache-Control',
      `public, max-age=${maxAgeSeconds}, stale-while-revalidate=${maxAgeSeconds * 5}`,
    );
    next();
  };
}
