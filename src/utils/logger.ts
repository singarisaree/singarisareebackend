import winston from 'winston';
import { isProduction } from '@/config/env';

const { combine, timestamp, printf, colorize, errors, json } = winston.format;

const consoleFormat = printf(({ level, message, timestamp: ts, ...meta }) => {
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${ts} [${level}]: ${message}${metaStr}`;
});

export const logger = winston.createLogger({
  level: isProduction ? 'info' : 'debug',
  format: combine(errors({ stack: true }), timestamp({ format: 'YYYY-MM-DD HH:mm:ss' })),
  defaultMeta: { service: 'singari-sarees-api' },
  transports: [
    new winston.transports.Console({
      format: isProduction
        ? combine(json())
        : combine(colorize(), consoleFormat),
    }),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error', format: json() }),
    new winston.transports.File({ filename: 'logs/combined.log', format: json() }),
  ],
});
