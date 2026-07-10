import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Response } from 'express';

/**
 * Sanitized error responses: internal errors are logged server-side with a
 * correlation id, but clients only ever see a generic message — never stack
 * traces, SQL, or library internals.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      return res.status(status).json(typeof body === 'string' ? { statusCode: status, message: body } : body);
    }

    const correlationId = Math.random().toString(36).slice(2, 10);
    this.logger.error(
      `[${correlationId}] ${req.method} ${req.url} :: ${(exception as Error)?.message}`,
      (exception as Error)?.stack,
    );
    return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: 500,
      message: 'Internal server error',
      correlationId,
    });
  }
}
