import {
  BasicRateLimiter,
  Chapter,
  ChapterDetails,
  ChapterProviding,
  ContentRating,
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

type KaynscanImplementation = Extension &
  SearchResultsProviding &
  MangaProviding &
  ChapterProviding &
  DiscoverSectionProviding;

export class KaynscanExtension implements KaynscanImplementation {
  requestManager = new KaynscanInterceptor("main");
  globalRateLimiter = new BasicRateLimiter("rateLimiter", {
    numberOfRequests: 5,
    bufferInterval: 1,
    ignoreImages: true,
  });

  async initialise(): Promise<void> {
    this.requestManager.registerInterceptor();
    this.globalRateLimiter.registerInterceptor();
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
      const mangaIdMatch = href.match(/\/series\/([^\/]+)/);
      const mangaId = mangaIdMatch ? mangaIdMatch[1] : "";
      
      // Get image from background-image style
      const imageDiv = link.find("div[style*='background-image']").first();
      const styleAttr = imageDiv.attr("style") || "";
      const imageMatch = styleAttr.match(/url\(([^)]+)\)/);
      const image = imageMatch ? imageMatch[1] : "";

      if (title && mangaId && !collectedIds.includes(mangaId)) {
        collectedIds.push(mangaId);
        if (section.id === "popular") {
          items.push({
            type: "featuredCarouselItem",
            mangaId: mangaId,
            imageUrl: image.startsWith("http") ? image : `${baseUrl}${image}`,
            title: title,
            metadata: undefined,
          });
        } else {
          items.push({
            type: "chapterUpdatesCarouselItem",
            mangaId: mangaId,
            imageUrl: image.startsWith("http") ? image : `${baseUrl}${image}`,
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
      
      const mangaIdMatch = href.match(/\/series\/([^\/]+)/);
      const mangaId = mangaIdMatch ? mangaIdMatch[1] : "";
      
      const imageDiv = link.find("div[style*='background-image']").first();
      const styleAttr = imageDiv.attr("style") || "";
      const imageMatch = styleAttr.match(/url\(([^)]+)\)/);
      const image = imageMatch ? imageMatch[1] : "";

      if (title && mangaId) {
        searchResults.push({
          mangaId: mangaId,
          imageUrl: image.startsWith("http") ? image : `${baseUrl}${image}`,
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
      url: `${baseUrl}/series/${mangaId}`,
      method: "GET",
    };

    const $ = await this.fetchCheerio(request);

    const title = $("h1, .title, .series-title").first().text().trim();
    const image = $(".cover img, .thumbnail img").attr("src") || 
                  $(".cover img, .thumbnail img").attr("data-src") || "";
    const description = $(".summary, .description, .synopsis").text().trim();
    
    let status = "UNKNOWN";
    const statusText = $(".status").text().toLowerCase();
    if (statusText.includes("ongoing")) {
      status = "ONGOING";
    } else if (statusText.includes("completed")) {
      status = "COMPLETED";
    }

    const tags: TagSection[] = [];
    const genres: string[] = [];
    
    $(".genre, .genres a, .tag").each((_, element) => {
      const genre = $(element).text().trim();
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
        thumbnailUrl: image.startsWith("http") ? image : `${baseUrl}${image}`,
        synopsis: description,
        contentRating: ContentRating.EVERYONE,
        status: status as "ONGOING" | "COMPLETED" | "UNKNOWN",
        tagGroups: tags,
      },
    };
  }

  async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
    const request = {
      url: `${baseUrl}/series/${sourceManga.mangaId}`,
      method: "GET",
    };

    const $ = await this.fetchCheerio(request);
    const chapters: Chapter[] = [];

    // Kaynscan chapter links: <a href="/chapter/640d715df1f-640d77c18dc/" c="1">
    $("a[href*='/chapter/']").each((_, element) => {
      const link = $(element);
      const chapterUrl = link.attr("href") || "";
      
      if (!chapterUrl) return;

      // Extract full chapter ID from URL like /chapter/640d715df1f-640d77c18dc/
      const chapterIdMatch = chapterUrl.match(/\/chapter\/([^\/]+)/);
      if (!chapterIdMatch) return;
      
      const chapterId = chapterIdMatch[1];
      
      // Get chapter number from 'c' attribute or title
      const chapterNumAttr = link.attr("c");
      const titleText = link.attr("title") || link.find(".text-sm").text().trim();
      
      let chapterNumber = 0;
      if (chapterNumAttr) {
        chapterNumber = Number(chapterNumAttr);
      } else {
        const numMatch = titleText.match(/(?:Chapter|Ch\.?)\s*(\d+(?:\.\d+)?)/i);
        if (numMatch) {
          chapterNumber = Number(numMatch[1]);
        }
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
    const chapterUrl = `${baseUrl}/chapter/${chapter.chapterId}`;

    try {
      const request: Request = { url: chapterUrl, method: "GET" };
      const $ = await this.fetchCheerio(request);

      const pages: string[] = [];

      // Kaynscan images: <img src="https://cdn.meowing.org/..." class="lazy w-full myImage">
      $("img.myImage, img[src*='cdn.meowing'], img[src*='kaynscan']").each((_, element) => {
        const src = $(element).attr("src") || $(element).attr("data-src") || "";
        if (src && src.startsWith("http")) {
          pages.push(src);
        }
      });

      // Also check for images in script tags if none found
      if (pages.length === 0) {
        const scriptContent = $('script').html() || "";
        const imageMatch = scriptContent.match(/images\s*=\s*\[(.*?)\]/s);
        if (imageMatch) {
          const imagesStr = imageMatch[1];
          const imageUrls = imagesStr.match(/"([^"]+)"/g);
          if (imageUrls) {
            imageUrls.forEach((url) => {
              const cleanUrl = url.replace(/"/g, "");
              pages.push(cleanUrl.startsWith("http") ? cleanUrl : `${baseUrl}${cleanUrl}`);
            });
          }
        }
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
    return `${baseUrl}/series/${mangaId}`;
  }

  async fetchCheerio(request: Request): Promise<CheerioAPI> {
    const [response, data] = await Application.scheduleRequest(request);
    const htmlStr = Application.arrayBufferToUTF8String(data);
    const dom = htmlparser2.parseDocument(htmlStr);
    return cheerio.load(dom);
  }
}

export const Kaynscan = new KaynscanExtension();
