import winston from 'winston';

const { createLogger, format, transports } = winston;
const { combine, timestamp, errors, json, printf, colorize } = format;

// Custom format for console output (development)
const consoleFormat = printf(({ level, message, timestamp, ...metadata }) => {
  let msg = `${timestamp} [${level}]: ${message}`;
  if (Object.keys(metadata).length > 0) {
    msg += ` ${JSON.stringify(metadata)}`;
  }
  return msg;
});

// Determine if we're in production (structured JSON) or development (pretty console)
const isProduction = process.env.NODE_ENV === 'production';

/**
 * Creates and configures the Winston logger
 */
function createAppLogger() {
  const logFormat = isProduction
    ? combine(timestamp(), errors({ stack: true }), json())
    : combine(
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        errors({ stack: true }),
        colorize(),
        consoleFormat
      );

  const logger = createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: logFormat,
    defaultMeta: { service: 'discord-relay' },
    transports: [
      new transports.Console({
        stderrLevels: ['error'],
      }),
    ],
  });

  // Handle uncaught exceptions and unhandled rejections
  logger.exceptions.handle(new transports.Console({ format: logFormat }));
  logger.rejections.handle(new transports.Console({ format: logFormat }));

  return logger;
}

const logger = createAppLogger();

export default logger;
