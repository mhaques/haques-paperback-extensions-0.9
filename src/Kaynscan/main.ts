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
      const mangaIdMatch = href.match(/\/series\/([^\/\?]+)/);
      const mangaId = mangaIdMatch ? mangaIdMatch[1] : "";
      
      // Skip invalid IDs: must be alphanumeric (with some symbols), no spaces, no query params
      if (!mangaId || mangaId === "" || !title) return;
      if (mangaId.includes("?") || mangaId.includes(" ") || mangaId.length < 3) return;
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
            imageUrl: ensureHttps(image.startsWith("http") ? image : `${baseUrl}${image}`),
            title: title,
            metadata: undefined,
          });
        } else {
          items.push({
            type: "chapterUpdatesCarouselItem",
            mangaId: mangaId,
            imageUrl: ensureHttps(image.startsWith("http") ? image : `${baseUrl}${image}`),
            title: title,
            chapterId: "1",
            metadata: undefined,
          });
        }
      }
    });

    const hasNextPage = $(".pagination .next, .next-page, a[rel='next']").length > 0;

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
      
      const mangaIdMatch = href.match(/\/series\/([^\/\?]+)/);
      const mangaId = mangaIdMatch ? mangaIdMatch[1] : "";
      
      // Skip invalid IDs: must be alphanumeric (with some symbols), no spaces, no query params
      if (!mangaId || mangaId === "" || !title) return;
      if (mangaId.includes("?") || mangaId.includes(" ") || mangaId.length < 3) return;
      
      const imageDiv = link.find("div[style*='background-image']").first();
      const styleAttr = imageDiv.attr("style") || "";
      const imageMatch = styleAttr.match(/url\(([^)]+)\)/);
      let image = imageMatch ? imageMatch[1] : "";
      
      // Clean up the image URL (remove quotes if present)
      image = image.replace(/['"]/g, "");

      if (title && mangaId) {
        searchResults.push({
          mangaId: mangaId,
          imageUrl: ensureHttps(image.startsWith("http") ? image : `${baseUrl}${image}`),
          title: title,
        });
      }
    });

    const hasNextPage = $(".pagination .next, .next-page, a[rel='next']").length > 0;

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
    
    // Cover image is in style attribute with --photoURL CSS variable
    const coverDiv = $(".bg-\\[image\\:--photoURL\\]").first();
    const styleAttr = coverDiv.attr("style") || "";
    const imageMatch = styleAttr.match(/--photoURL:url\(([^)]+)\)/);
    const image = imageMatch ? imageMatch[1] : "";
    
    // Description is in a <p> tag with white-space: pre-wrap
    const description = $("p[style*='white-space']").text().trim();
    
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
    
    // Genres are in <a> tags with href containing "?genre="
    $("a[href*='?genre=']").each((_, element) => {
      const genre = $(element).find("span").last().text().trim();
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
        thumbnailUrl: ensureHttps(image.startsWith("http") ? image : `${baseUrl}${image}`),
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
      const hasLockOverlay = link.find("div.absolute").find("img[src*='lock']").length > 0;
      
      // Also check coin cost - locked chapters have c="75" or higher, free chapters have c="1" 
      const coinCost = link.attr("c") || "1";
      const isLocked = hasLockOverlay || parseInt(coinCost) > 1;
      
      if (isLocked) return;

      // Extract full chapter ID from URL like /chapter/640d715df1f-640d77c18dc/
      const chapterIdMatch = chapterUrl.match(/\/chapter\/([^\/]+)/);
      if (!chapterIdMatch) return;
      
      const chapterId = chapterIdMatch[1];
      
      // Get chapter number from 'c' attribute or title - note: 'c' is actually the order, not chapter number
      const titleText = link.attr("title") || link.find(".text-sm").text().trim();
      
      let chapterNumber = 0;
      // Extract chapter number from title like "Chapter 145"
      const numMatch = titleText.match(/Chapter\s+(\d+(?:\.\d+)?)/i);
      if (numMatch) {
        chapterNumber = Number(numMatch[1]);
      }
      
      if (isNaN(chapterNumber) || chapterNumber === 0) return;

      const chapterTitle = titleText || `Chapter ${chapterNumber}`;
      const dateText = link.find(".text-xs.text-white\\/50").text().trim() || 
                       link.attr("d") || "";

      chapters.push({
        chapterId: chapterId,
        title: chapterTitle,
        sourceManga,
        chapNum: chapterNumber,
        publishDate: dateText ? new Date(dateText) : undefined,
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

      // Kaynscan images: <img src="https://cdn.meowing.org/..." class="lazy w-full myImage">
      $("img.myImage").each((_, element) => {
        const src = $(element).attr("src") || "";
        if (src) {
          // Ensure HTTPS and add to pages
          pages.push(ensureHttps(src));
        }
      });

      // If no images found with myImage class, try other selectors
      if (pages.length === 0) {
        $("img[src*='cdn.meowing'], img[src*='cdn.kaynscan']").each((_, element) => {
          const src = $(element).attr("src") || $(element).attr("data-src") || "";
          if (src && src.startsWith("http")) {
            pages.push(ensureHttps(src));
          }
        });
      }

      // Also check for images in script tags if still none found
      if (pages.length === 0) {
        const scriptContent = $('script').html() || "";
        const imageMatch = scriptContent.match(/images\s*=\s*\[(.*?)\]/s);
        if (imageMatch) {
          const imagesStr = imageMatch[1];
          const imageUrls = imagesStr.match(/"([^"]+)"/g);
          if (imageUrls) {
            imageUrls.forEach((url) => {
              const cleanUrl = url.replace(/"/g, "");
              pages.push(ensureHttps(cleanUrl.startsWith("http") ? cleanUrl : `${baseUrl}${cleanUrl}`));
            });
          }
        }
      }

      // If no pages found, throw error
      if (pages.length === 0) {
        throw new Error("No images found for this chapter. It may be locked or unavailable.");
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
