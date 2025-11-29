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
    // Check for redirects and force them to HTTPS
    if (response.status >= 300 && response.status < 400) {
      const location =
        response.headers?.["location"] || response.headers?.["Location"];
      if (location && location.startsWith("http://")) {
        // Manually follow redirect with HTTPS
        const httpsLocation = location.replace("http://", "https://");
        const redirectRequest: Request = {
          url: httpsLocation,
          method: "GET",
          headers: request.headers,
        };
        const [, newData] = await Application.scheduleRequest(redirectRequest);
        return newData;
      }
    }
    return data;
  }
}
