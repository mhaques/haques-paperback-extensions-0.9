import { PaperbackInterceptor, Request, Response } from "@paperback/types";

export class KaynscanInterceptor extends PaperbackInterceptor {
  override async interceptRequest(request: Request): Promise<Request> {
    // Force HTTPS for all requests
    if (request.url.startsWith("http://")) {
      request.url = request.url.replace("http://", "https://");
    }
    
    request.headers = {
      ...request.headers,
      referer: `https://kaynscan.com/`,
      "user-agent": await Application.getDefaultUserAgent(),
    };
    return request;
  }

  override async interceptResponse(
    request: Request,
    response: Response,
    data: ArrayBuffer,
  ): Promise<ArrayBuffer> {
    return data;
  }
}
