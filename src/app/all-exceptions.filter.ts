import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { Response } from "express";
import type { RequestWithId } from "./request-id.js";

/**
 * One error shape for every response. Expected (HTTP) errors keep their message so clients
 * can show it; anything unexpected is logged and answered with a generic message, so stack
 * traces, SQL and hostnames never reach a client.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<RequestWithId>();
    const res = http.getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const details = typeof body === "string" ? { message: body } : (body as object);
      res.status(status).json({
        statusCode: status,
        error: (details as { error?: string }).error ?? httpStatusName(status),
        message: (details as { message?: unknown }).message ?? exception.message,
        // A fixed word the app can act on (e.g. "email_not_verified"), never shown to people.
        ...(typeof (details as { code?: unknown }).code === "string"
          ? { code: (details as { code: string }).code }
          : {}),
        // Field-level problems a form can show (e.g. { password: ["too_short"] }).
        ...((details as { details?: unknown }).details
          ? { details: (details as { details: unknown }).details }
          : {}),
        requestId: req.id,
      });
      return;
    }

    // Express middleware (e.g. the body parser) throws http-errors, not HttpException.
    // Only 4xx errors explicitly marked safe to expose are passed through.
    if (isExposableClientError(exception)) {
      res.status(exception.status).json({
        statusCode: exception.status,
        error: httpStatusName(exception.status),
        message: exception.message,
        requestId: req.id,
      });
      return;
    }

    this.logger.error({ err: exception, requestId: req.id }, "Unhandled error");
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: "Internal Server Error",
      message: "Something went wrong",
      requestId: req.id,
    });
  }
}

function isExposableClientError(
  error: unknown,
): error is { status: number; message: string; expose: true } {
  if (typeof error !== "object" || error === null) return false;
  const { status, expose } = error as { status?: unknown; expose?: unknown };
  return typeof status === "number" && status >= 400 && status < 500 && expose === true;
}

function httpStatusName(status: number): string {
  const name = HttpStatus[status];
  return name
    ? name
        .toLowerCase()
        .split("_")
        .map((w) => w[0]!.toUpperCase() + w.slice(1))
        .join(" ")
    : "Error";
}
