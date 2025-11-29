import {
  BasicRateLimiter,
  Chapter,
  ChapterDetails,
  ChapterProviding,
  CloudflareBypassRequestProviding,
  CloudflareError,
  ContentRating,
  Cookie,
  CookieStorageInterceptor,
  DiscoverSection,
  DiscoverSectionItem,
  DiscoverSectionProviding,
  DiscoverSectionType,
  Extension,
  MangaProviding,
  PagedResults,
  Request,
  SearchFilter,
  SearchQuery,
  SearchResultItem,
  SearchResultsProviding,
  SourceManga,
  TagSection,
} from "@paperback/types";
import * as cheerio from "cheerio";
import { CheerioAPI } from "cheerio";
import * as htmlparser2 from "htmlparser2";
import { KaynscanMetadata } from "./Kaynscan";
import { KaynscanInterceptor } from "./KaynscanInterceptor";

const baseUrl = "https://kaynscan.com";

// Helper function to ensure URLs use HTTPS
function ensureHttps(url: string): string {
  if (url.startsWith("http://")) {
    return url.replace("http://", "https://");
  }
  return url;
}

type KaynscanImplementation = Extension &
  SearchResultsProviding &
  MangaProviding &
  ChapterProviding &
  DiscoverSectionProviding &
  CloudflareBypassRequestProviding;

export class KaynscanExtension implements KaynscanImplementation {
  requestManager = new KaynscanInterceptor("main");
  globalRateLimiter = new BasicRateLimiter("rateLimiter", {
    numberOfRequests: 5,
    bufferInterval: 1,
    ignoreImages: true,
  });
  cookieStorageInterceptor = new CookieStorageInterceptor({
    storage: "stateManager",
  });

  async initialise(): Promise<void> {
    this.requestManager.registerInterceptor();
    this.globalRateLimiter.registerInterceptor();
    this.cookieStorageInterceptor.registerInterceptor();
  }

  async saveCloudflareBypassCookies(cookies: Cookie[]): Promise<void> {
    for (const cookie of this.cookieStorageInterceptor.cookies) {
      this.cookieStorageInterceptor.deleteCookie(cookie);
    }
    for (const cookie of cookies) {
      if (cookie.expires && cookie.expires.getTime() <= Date.now()) {
        continue;
      }
      this.cookieStorageInterceptor.setCookie(cookie);
    }
  }

  checkCloudflareStatus(status: number): void {
    if (status == 503 || status == 403) {
      // Explicitly use https:// URL for CloudflareError
      throw new CloudflareError({ url: "https://kaynscan.com", method: "GET" });
    }
  }

  async getDiscoverSections(): Promise<DiscoverSection[]> {
    return [
      {
        id: "popular",
        title: "Popular",
        type: DiscoverSectionType.featured,
      },
      {
        id: "latest",
        title: "Latest Updates",
        type: DiscoverSectionType.chapterUpdates,
      },
    ];
  }

  async getSearchFilters(): Promise<SearchFilter[]> {
    return [];
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata: KaynscanMetadata | undefined,
  ): Promise<PagedResults<DiscoverSectionItem>> {
    const page = metadata?.page ?? 1;
    const collectedIds = metadata?.collectedIds ?? [];

    let url = `${baseUrl}`;

    if (section.id === "popular") {
      url = `${baseUrl}/series?page=${page}&order=popular`;
    } else if (section.id === "latest") {
      url = `${baseUrl}/series?page=${page}&order=update`;
    }

    const request = { url, method: "GET" };
    const $ = await this.fetchCheerio(request);
    const items: DiscoverSectionItem[] = [];

    // Kaynscan manga cards: <a href="/series/{id}/" class="grid border aspect-[0.75/1]...">
    $("a[href*='/series/']").each((_, element) => {
      const link = $(element);
      const href = link.attr("href") || "";
      const title = link.attr("title") || link.attr("alt") || "";

      // Extract manga ID from URL like /series/640e17f407b/
      const mangaIdMatch = href.match(/\/series\/([^/?]+)/);
      const mangaId = mangaIdMatch ? mangaIdMatch[1] : "";

      // Skip invalid IDs: must be alphanumeric (with some symbols), no spaces, no query params
      if (!mangaId || mangaId === "" || !title) return;
      if (mangaId.includes("?") || mangaId.includes(" ") || mangaId.length < 3)
        return;
      if (collectedIds.includes(mangaId)) return;

      // Get image from background-image style
      const imageDiv = link.find("div[style*='background-image']").first();
      const styleAttr = imageDiv.attr("style") || "";
      const imageMatch = styleAttr.match(/url\(([^)]+)\)/);
      let image = imageMatch ? imageMatch[1] : "";

      // Clean up the image URL (remove quotes if present)
      image = image.replace(/['"]/g, "");

      if (mangaId && title) {
        collectedIds.push(mangaId);
        if (section.id === "popular") {
          items.push({
            type: "featuredCarouselItem",
            mangaId: mangaId,
            imageUrl: ensureHttps(
              image.startsWith("http") ? image : `${baseUrl}${image}`,
            ),
            title: title,
            metadata: undefined,
          });
        } else {
          items.push({
            type: "chapterUpdatesCarouselItem",
            mangaId: mangaId,
            imageUrl: ensureHttps(
              image.startsWith("http") ? image : `${baseUrl}${image}`,
            ),
            title: title,
            chapterId: "1",
            metadata: undefined,
          });
        }
      }
    });

    const hasNextPage =
      $(".pagination .next, .next-page, a[rel='next']").length > 0;

    return {
      items: items,
      metadata: hasNextPage ? { page: page + 1, collectedIds } : undefined,
    };
  }

  async getSearchResults(
    query: SearchQuery,
    metadata: { page?: number } | undefined,
  ): Promise<PagedResults<SearchResultItem>> {
    const page = metadata?.page ?? 1;
    const searchUrl = `${baseUrl}/search?q=${encodeURIComponent(query.title || "")}&page=${page}`;

    const request = { url: searchUrl, method: "GET" };
    const $ = await this.fetchCheerio(request);
    const searchResults: SearchResultItem[] = [];

    // Same structure as homepage manga cards
    $("a[href*='/series/']").each((_, element) => {
      const link = $(element);
      const href = link.attr("href") || "";
      const title = link.attr("title") || link.attr("alt") || "";

      const mangaIdMatch = href.match(/\/series\/([^/?]+)/);
      const mangaId = mangaIdMatch ? mangaIdMatch[1] : "";

      // Skip invalid IDs: must be alphanumeric (with some symbols), no spaces, no query params
      if (!mangaId || mangaId === "" || !title) return;
      if (mangaId.includes("?") || mangaId.includes(" ") || mangaId.length < 3)
        return;

      const imageDiv = link.find("div[style*='background-image']").first();
      const styleAttr = imageDiv.attr("style") || "";
      const imageMatch = styleAttr.match(/url\(([^)]+)\)/);
      let image = imageMatch ? imageMatch[1] : "";

      // Clean up the image URL (remove quotes if present)
      image = image.replace(/['"]/g, "");

      if (title && mangaId) {
        searchResults.push({
          mangaId: mangaId,
          imageUrl: ensureHttps(
            image.startsWith("http") ? image : `${baseUrl}${image}`,
          ),
          title: title,
        });
      }
    });

    const hasNextPage =
      $(".pagination .next, .next-page, a[rel='next']").length > 0;

    return {
      items: searchResults,
      metadata: hasNextPage ? { page: page + 1 } : undefined,
    };
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const request = {
      url: `${baseUrl}/series/${mangaId}/`,
      method: "GET",
    };

    const $ = await this.fetchCheerio(request);

    const title = $("h1").first().text().trim();

    // Cover image - try multiple methods
    let image = "";

    // Method 1: CSS variable in style attribute with --photoURL
    const coverDiv = $(".bg-\\[image\\:--photoURL\\]").first();
    const styleAttr = coverDiv.attr("style") || "";
    const imageMatch = styleAttr.match(/--photoURL:url\(([^)]+)\)/);
    if (imageMatch) {
      image = imageMatch[1];
    }

    // Method 2: Look for any div with background-image in style
    if (!image) {
      $("div[style*='background-image']").each((_, element) => {
        const style = $(element).attr("style") || "";
        const bgMatch = style.match(/background-image:\s*url\(([^)]+)\)/);
        if (bgMatch) {
          image = bgMatch[1].replace(/['"]/g, "");
          return false; // break
        }
      });
    }

    // Method 3: Look for img tag in the header/top area
    if (!image) {
      const imgSrc = $("img[src*='cdn.meowing'], img[src*='wsrv.nl']")
        .first()
        .attr("src");
      if (imgSrc) image = imgSrc;
    }

    // Description - try multiple methods
    let description = "";

    // Method 1: p tag with white-space style
    description = $("p[style*='white-space']").first().text().trim();

    // Method 2: Look for p tag with pre-wrap class or in a specific container
    if (!description) {
      description = $("p.pre-wrap, div.description p, .synopsis p")
        .first()
        .text()
        .trim();
    }

    // Method 3: Any p tag that looks like a description (longer text)
    if (!description) {
      $("p").each((_, element) => {
        const text = $(element).text().trim();
        if (text.length > 50) {
          description = text;
          return false; // break
        }
      });
    }

    let status = "UNKNOWN";
    // Status is in a div with bg-green-500/80 for ongoing
    const statusDiv = $(".bg-green-500\\/80");
    if (statusDiv.length > 0) {
      const statusText = statusDiv.find("span").text().toLowerCase();
      if (statusText.includes("ongoing")) {
        status = "ONGOING";
      } else if (statusText.includes("completed")) {
        status = "COMPLETED";
      }
    }

    const tags: TagSection[] = [];
    const genres: string[] = [];

    // Genres are in <a href="/series/?genre=X"> tags with <span> inside
    $("a[href*='?genre=']").each((_, element) => {
      const genre = $(element).find("span").first().text().trim();
      if (genre) genres.push(genre);
    });

    if (genres.length > 0) {
      tags.push({
        id: "genres",
        title: "Genres",
        tags: genres.map((genre) => ({
          id: genre.toLowerCase().replace(/\s+/g, "-"),
          title: genre,
        })),
      });
    }

    return {
      mangaId: mangaId,
      mangaInfo: {
        primaryTitle: title,
        secondaryTitles: [],
        thumbnailUrl: ensureHttps(
          image.startsWith("http") ? image : `${baseUrl}${image}`,
        ),
        synopsis: description,
        contentRating: ContentRating.EVERYONE,
        status: status as "ONGOING" | "COMPLETED" | "UNKNOWN",
        tagGroups: tags,
      },
    };
  }

  async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
    const request = {
      url: `${baseUrl}/series/${sourceManga.mangaId}/`,
      method: "GET",
    };

    const $ = await this.fetchCheerio(request);
    const chapters: Chapter[] = [];

    // Kaynscan chapter links: <a href="/chapter/640d715df1f-640d77c18dc/" c="1">
    $("a[href*='/chapter/']").each((_, element) => {
      const link = $(element);
      const chapterUrl = link.attr("href") || "";

      if (!chapterUrl) return;

      // Skip locked/paywalled chapters - check for lock overlay div and coin cost
      // Locked chapters have: <div class="...absolute..."><img src="...lock.svg"></div>
      const hasLockOverlay =
        link.find("div.absolute").find("img[src*='lock']").length > 0;

      // Also check coin cost - locked chapters have c="75" or higher, free chapters have c="1"
      const coinCost = link.attr("c") || "1";
      const isLocked = hasLockOverlay || parseInt(coinCost) > 1;

      if (isLocked) return;

      // Extract full chapter ID from URL like /chapter/640d715df1f-640d77c18dc/
      const chapterIdMatch = chapterUrl.match(/\/chapter\/([^/]+)/);
      if (!chapterIdMatch) return;

      const chapterId = chapterIdMatch[1];

      // Get chapter number from 'c' attribute or title - note: 'c' is actually the order, not chapter number
      const titleText =
        link.attr("title") || link.find(".text-sm").text().trim();

      let chapterNumber = 0;
      // Extract chapter number from title like "Chapter 145"
      const numMatch = titleText.match(/Chapter\s+(\d+(?:\.\d+)?)/i);
      if (numMatch) {
        chapterNumber = Number(numMatch[1]);
      }

      if (isNaN(chapterNumber) || chapterNumber === 0) return;

      // Clean chapter title - just use "Chapter X" format
      const chapterTitle = `Chapter ${chapterNumber}`;

      // Date is in a div with class "text-xs text-white/50" inside the chapter link
      const dateText = link
        .find(".text-xs.text-white\\/50")
        .first()
        .text()
        .trim();

      // Parse relative time like "9 hours ago", "1 day ago", etc.
      let publishDate: Date | undefined = undefined;
      if (dateText) {
        const now = new Date();
        const timeMatch = dateText.match(
          /(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i,
        );
        if (timeMatch) {
          const value = parseInt(timeMatch[1]);
          const unit = timeMatch[2].toLowerCase();

          switch (unit) {
            case "second":
              publishDate = new Date(now.getTime() - value * 1000);
              break;
            case "minute":
              publishDate = new Date(now.getTime() - value * 60 * 1000);
              break;
            case "hour":
              publishDate = new Date(now.getTime() - value * 60 * 60 * 1000);
              break;
            case "day":
              publishDate = new Date(
                now.getTime() - value * 24 * 60 * 60 * 1000,
              );
              break;
            case "week":
              publishDate = new Date(
                now.getTime() - value * 7 * 24 * 60 * 60 * 1000,
              );
              break;
            case "month":
              publishDate = new Date(
                now.getTime() - value * 30 * 24 * 60 * 60 * 1000,
              );
              break;
            case "year":
              publishDate = new Date(
                now.getTime() - value * 365 * 24 * 60 * 60 * 1000,
              );
              break;
          }
        }
      }

      chapters.push({
        chapterId: chapterId,
        title: chapterTitle,
        sourceManga,
        chapNum: chapterNumber,
        publishDate: publishDate,
        langCode: "🇬🇧",
      });
    });

    return chapters.sort((a, b) => b.chapNum - a.chapNum);
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    // Chapter URL format: /chapter/640d715df1f-640d77c18dc/
    const chapterUrl = `${baseUrl}/chapter/${chapter.chapterId}/`;

    try {
      const request: Request = { url: chapterUrl, method: "GET" };
      const $ = await this.fetchCheerio(request);

      const pages: string[] = [];

      // Kaynscan images: <img src="https://cdn.meowing.org/uploads/..." uid="..." class="myImage">
      // Try multiple approaches to get images
      $("img.myImage").each((_, element) => {
        const img = $(element);
        let imageUrl = "";

        // First try src attribute
        const src = img.attr("src") || "";
        if (src && src.includes("cdn.meowing.org")) {
          imageUrl = src;
        }

        // If no valid src, build URL from uid attribute
        if (!imageUrl) {
          const uid = img.attr("uid") || "";
          if (uid) {
            imageUrl = `https://cdn.meowing.org/uploads/${uid}`;
          }
        }

        if (imageUrl) {
          pages.push(ensureHttps(imageUrl));
        }
      });

      // If no images found with myImage class, try other selectors
      if (pages.length === 0) {
        $("img[src*='cdn.meowing'], img[uid]").each((_, element) => {
          const img = $(element);
          const src = img.attr("src") || "";
          const uid = img.attr("uid") || "";

          if (src && src.includes("cdn.meowing.org")) {
            pages.push(ensureHttps(src));
          } else if (uid) {
            pages.push(ensureHttps(`https://cdn.meowing.org/uploads/${uid}`));
          }
        });
      }

      // Also check for images in script tags if still none found
      if (pages.length === 0) {
        const scriptContent = $("script").html() || "";
        const imageMatch = scriptContent.match(/images\s*=\s*\[(.*?)\]/s);
        if (imageMatch) {
          const imagesStr = imageMatch[1];
          const imageUrls = imagesStr.match(/"([^"]+)"/g);
          if (imageUrls) {
            imageUrls.forEach((url) => {
              const cleanUrl = url.replace(/"/g, "");
              pages.push(
                ensureHttps(
                  cleanUrl.startsWith("http")
                    ? cleanUrl
                    : `${baseUrl}${cleanUrl}`,
                ),
              );
            });
          }
        }
      }

      // If no pages found, throw error
      if (pages.length === 0) {
        throw new Error(
          "No images found for this chapter. It may be locked or unavailable.",
        );
      }

      return {
        mangaId: chapter.sourceManga.mangaId,
        id: chapter.chapterId,
        pages: pages,
      };
    } catch (error) {
      console.error("Error fetching chapter details:", error);
      throw error;
    }
  }

  getMangaShareUrl(mangaId: string): string {
    return `${baseUrl}/series/${mangaId}/`;
  }

  async fetchCheerio(request: Request): Promise<CheerioAPI> {
    const [response, data] = await Application.scheduleRequest(request);
    this.checkCloudflareStatus(response.status);
    const htmlStr = Application.arrayBufferToUTF8String(data);
    const dom = htmlparser2.parseDocument(htmlStr);
    return cheerio.load(dom);
  }
}

export const Kaynscan = new KaynscanExtension();
