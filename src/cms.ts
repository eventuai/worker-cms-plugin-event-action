// ============================================================
// Event Actions CMS bridge.
//
// Shared Plugin API client/types and neutral lect readers live in
// @lionrockjs/worker-cms-plugin. This file adds only what this plugin needs on
// top: the acting-user attribution wrapper and offset pagination (`listAll`),
// both mirroring cms-plugin-events so behaviour stays consistent across the
// suite.
// ============================================================

import {
  CmsClient as BaseCmsClient,
  attr,
  blocks,
  items,
  localized,
  pointer,
  type CmsClientEnv,
  type CmsListPointer,
  type CmsPage,
  type CmsPageInput,
  CmsApiError,
  CmsNotConfiguredError,
} from '@lionrockjs/worker-cms-plugin';

/** Manifest id — must equal MANIFEST.id and the CMS-registered plugin id. */
export const PLUGIN_ID = 'event-actions';

export {
  CmsApiError,
  CmsNotConfiguredError,
  attr,
  blocks,
  items,
  localized,
  pointer,
  type CmsClientEnv,
  type CmsPage,
  type CmsPageInput,
};

export class CmsClient extends BaseCmsClient {
  /** The base `call`/`json` are private, so listAll keeps its own copy of the link config. */
  private readonly link: { base: string; secret: string };
  private actingUserId: string | null = null;

  constructor(env: CmsClientEnv) {
    super({
      cmsUrl: env.CMS_URL,
      pluginSecret: env.PLUGIN_SECRET,
      pluginId: PLUGIN_ID,
      fetcher: (input, init) => globalThis.fetch(input, this.withActingUser(init)),
    });
    this.link = { base: (env.CMS_URL ?? '').replace(/\/+$/, ''), secret: env.PLUGIN_SECRET ?? '' };
  }

  /**
   * Attributes subsequent CMS calls to the signed-in admin (from the
   * `x-cms-user` summary the host forwards), so host-side credit costs are
   * charged to them. Cron runs stay unset and uncharged.
   */
  actAs(userId: string | number | null | undefined): this {
    this.actingUserId = userId === null || userId === undefined || userId === '' ? null : String(userId);
    return this;
  }

  /**
   * Every page matching the query. The host clamps `/__cms/pages` to 500 rows
   * per call no matter what `limit` asks, so a plain `list()` silently
   * truncates collections past 500 (large guest lists) — this pages by offset
   * until the set is exhausted. On a transient host failure the page size
   * halves (500 → 250 → … → 50) and the same offset retries; follow-up pages
   * send `count=0` so the host skips re-counting the filtered set.
   */
  async listAll(
    pageType: string,
    opts: { parentId?: number; pointer?: CmsListPointer; q?: string; fields?: string[] } = {},
  ): Promise<CmsPage[]> {
    const pages: CmsPage[] = [];
    let pageSize = 500;
    let total: number | null = null; // fetched with the first page only
    for (;;) {
      let chunk: CmsPage[];
      try {
        const result = await this.listPage(pageType, opts, pageSize, pages.length, total === null);
        if (total === null) total = result.total;
        chunk = result.pages;
      } catch (error) {
        const transient = error instanceof CmsApiError && [429, 500, 502, 503, 504].includes(error.status);
        if (!transient || pageSize <= 50) throw error;
        pageSize = Math.max(50, Math.floor(pageSize / 2));
        continue;
      }
      pages.push(...chunk);
      if (!chunk.length || chunk.length < pageSize || (total >= 0 && pages.length >= total)) return pages;
    }
  }

  /**
   * One raw GET /__cms/pages call. Exists because the SDK's `list()` cannot
   * send `count=0` or `fields=` — mirrors its parameter encoding.
   */
  private async listPage(
    pageType: string,
    opts: { parentId?: number; pointer?: CmsListPointer; q?: string; fields?: string[] },
    limit: number,
    offset: number,
    wantCount: boolean,
  ): Promise<{ pages: CmsPage[]; total: number }> {
    const params = new URLSearchParams({ page_type: pageType });
    if (opts.parentId != null) params.set('page_id', String(opts.parentId));
    if (opts.pointer) {
      params.set('pointer_key', opts.pointer.key);
      if ('values' in opts.pointer) params.set('pointer_values', opts.pointer.values.map(String).join(','));
      else params.set('pointer_value', String(opts.pointer.value));
    }
    if (opts.q) params.set('q', opts.q);
    if (opts.fields?.length) params.set('fields', opts.fields.join(','));
    params.set('limit', String(limit));
    params.set('offset', String(offset));
    if (!wantCount) params.set('count', '0');

    const path = `/pages?${params}`;
    const response = await globalThis.fetch(`${this.link.base}/__cms${path}`, { headers: this.linkHeaders() });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let code = 'error';
      if (text) {
        try {
          const parsed = JSON.parse(text) as { error?: unknown };
          code = typeof parsed.error === 'string' && parsed.error ? parsed.error : 'error';
        } catch {
          code = text.replace(/\s+/g, ' ').trim().slice(0, 160) || 'error';
        }
      }
      throw new CmsApiError(response.status, code, 'GET', path);
    }
    return response.json();
  }

  private withActingUser(init?: RequestInit): RequestInit {
    if (!this.actingUserId) return init ?? {};
    const headers = new Headers(init?.headers);
    headers.set('x-acting-user-id', this.actingUserId);
    // Plain object (not a Headers instance) so callers and tests that inspect
    // init.headers by key keep working.
    return { ...init, headers: Object.fromEntries(headers.entries()) };
  }

  /** Auth + attribution headers for this class's own raw /__cms fetches. */
  private linkHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'x-plugin-secret': this.link.secret,
      'x-plugin-id': PLUGIN_ID,
      ...(this.actingUserId ? { 'x-acting-user-id': this.actingUserId } : {}),
      ...extra,
    };
  }
}

/** Parses a page id from route segments / form fields / pointers. */
export function pageId(value: string | number | null | undefined): number | null {
  const id = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}
