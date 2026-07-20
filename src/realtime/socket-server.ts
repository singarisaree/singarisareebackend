import type { Server as HttpServer } from 'http';
import { Server } from 'socket.io';
import * as cookie from 'cookie';
import jwt from 'jsonwebtoken';
import { env, isDevelopment } from '@/config/env';
import { logger } from '@/utils/logger';
import type { JwtPayload } from '@/middleware/auth';
import { setSocketServer } from '@/realtime/emitter';
import { REALTIME_EVENTS } from '@/realtime/events';
import { isValidRealtimePhone, normalizePhoneForRealtime } from '@/realtime/phone';

const ADMIN_ROOM = 'admin';
const cookieModule = cookie as unknown as {
  parse?: (cookieHeader: string) => Record<string, string>;
  parseCookie?: (cookieHeader: string) => Record<string, string>;
};
const parseCookieHeader =
  cookieModule.parseCookie ??
  cookieModule.parse ??
  (() => ({} as Record<string, string>));

function isAllowedDevOrigin(origin: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})(:\d+)?$/.test(
    origin,
  );
}

function verifyAdminToken(token: string | undefined): JwtPayload | null {
  if (!token) return null;
  try {
    return jwt.verify(token, env.JWT_ACCESS_SECRET) as JwtPayload;
  } catch {
    return null;
  }
}

function getAccessTokenFromSocket(socket: {
  handshake: { headers: { cookie?: string }; auth?: Record<string, unknown> };
}): string | undefined {
  const authToken = socket.handshake.auth?.token;
  if (typeof authToken === 'string' && authToken.trim()) return authToken.trim();

  const cookies = parseCookieHeader(socket.handshake.headers.cookie || '');
  return cookies.accessToken;
}

export function initSocketServer(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    path: '/socket.io',
    cors: {
      origin: (origin, callback) => {
        if (!origin) {
          callback(null, true);
          return;
        }
        if (origin === env.FRONTEND_URL || (isDevelopment && isAllowedDevOrigin(origin))) {
          callback(null, true);
          return;
        }
        callback(null, false);
      },
      credentials: true,
    },
  });

  io.on('connection', (socket) => {
    const admin = verifyAdminToken(getAccessTokenFromSocket(socket));
    if (admin) {
      void socket.join(ADMIN_ROOM);
      socket.data.isAdmin = true;
      socket.emit(REALTIME_EVENTS.CONNECTION_READY, { role: 'admin' });
      logger.debug('Admin socket joined', { socketId: socket.id, adminId: admin.sub });
    } else {
      socket.emit(REALTIME_EVENTS.CONNECTION_READY, { role: 'guest' });
    }

    // Re-join admin room after login/reconnect (client may reconnect with fresh cookies).
    socket.on(REALTIME_EVENTS.ADMIN_JOIN, () => {
      const verified = verifyAdminToken(getAccessTokenFromSocket(socket));
      if (!verified) {
        socket.emit(REALTIME_EVENTS.CONNECTION_READY, { role: 'guest', error: 'unauthorized' });
        return;
      }
      void socket.join(ADMIN_ROOM);
      socket.data.isAdmin = true;
      socket.emit(REALTIME_EVENTS.CONNECTION_READY, { role: 'admin' });
    });

    socket.on(REALTIME_EVENTS.CUSTOMER_SUBSCRIBE, (payload: { phone?: string }) => {
      const phone = payload?.phone?.trim();
      if (!phone) return;
      const normalized = normalizePhoneForRealtime(phone);
      if (!isValidRealtimePhone(normalized)) return;

      const previousPhone = socket.data.customerPhone as string | undefined;
      if (previousPhone && previousPhone !== normalized) {
        void socket.leave(`customer:${previousPhone}`);
      }

      socket.data.customerPhone = normalized;
      void socket.join(`customer:${normalized}`);
      socket.emit(REALTIME_EVENTS.CONNECTION_READY, {
        role: socket.data.isAdmin ? 'admin' : 'customer',
        phone: normalized,
      });
    });

    socket.on(REALTIME_EVENTS.CUSTOMER_UNSUBSCRIBE, (payload: { phone?: string }) => {
      const phone = payload?.phone?.trim() || (socket.data.customerPhone as string | undefined);
      if (!phone) return;
      const normalized = normalizePhoneForRealtime(phone);
      void socket.leave(`customer:${normalized}`);
      if (socket.data.customerPhone === normalized) {
        socket.data.customerPhone = undefined;
      }
    });

    socket.on('disconnect', (reason) => {
      logger.debug('Socket disconnected', { socketId: socket.id, reason });
    });
  });

  setSocketServer(io);
  logger.info('Socket.IO server initialized');
  return io;
}
