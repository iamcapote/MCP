import axios from 'axios';
import { RateLimiter } from '../../utils/research.rate-limiter.mjs';
import { cleanQuery } from '../../utils/research.clean-query.mjs';

export class SearchError extends Error {
  constructor(code, message, provider) {
    super(message);
    this.code = code;
    this.provider = provider;
    this.name = 'SearchError';
  }
}

export class BraveSearchProvider {
  constructor(options = {}) {
    this.type = 'web';
    this.baseUrl = 'https://api.search.brave.com/res/v1';

    this.apiKey = options.apiKey || process.env.BRAVE_API_KEY;

    if (!this.apiKey) {
      console.error('[BraveSearchProvider] CRITICAL: No API Key provided or found in environment variables (BRAVE_API_KEY).');
      throw new SearchError('ConfigError', 'Missing BRAVE_API_KEY', 'Brave');
    }

    console.log(`[BraveSearchProvider] Initialized using ${options.apiKey ? 'User-Provided' : 'Global Environment'} API Key.`);

    this.rateLimiter = new RateLimiter(10000); // 10 seconds base delay
    this.retryDelay = 5000; // Start with 5 seconds for retries
    this.maxRetries = 3;
    this.output = options.outputFn || console.log; // Add outputFn
    this.error = options.errorFn || console.error; // Add errorFn
  }

  async makeRequest(query) {
    if (!this.apiKey) {
      console.error('[BraveSearchProvider] makeRequest called without a valid API key.');
      this.error('[BraveSearchProvider] makeRequest called without a valid API key.');
      throw new SearchError('ConfigError', 'Missing BRAVE_API_KEY during request', 'Brave');
    }
    try {
      await this.rateLimiter.waitForNextSlot();
      this.output(`[BraveSearchProvider] Searching for: "${query}"`);
      const response = await axios.get(`${this.baseUrl}/web/search`, {
        headers: {
          Accept: 'application/json',
          'X-Subscription-Token': this.apiKey,
        },
        params: {
          q: query,
          count: 10,
          offset: 0,
          language: 'en',
          country: 'US',
          safesearch: 'moderate',
          format: 'json',
        },
      });

      if (!response.data?.web?.results) {
        console.error('[BraveSearchProvider] Unexpected response shape:', response.data);
        this.error('[BraveSearchProvider] Unexpected response shape:', response.data);
        return [];
      }

      return response.data.web.results.map((r) => ({
        title: r.title || 'Untitled',
        content: r.description || 'No description available',
        source: r.url || '',
        type: this.type,
        url: r.url || ''
      }));
    } catch (error) {
      if (error.response?.status === 429) {
        console.error('[BraveSearchProvider] Rate-limited by Brave.');
        this.output('[BraveSearchProvider] Rate-limited by Brave.');
        throw new SearchError('RATE_LIMIT', 'Rate-limited by Brave', 'Brave');
      } else if (error.response?.status === 422) {
        console.error('[BraveSearchProvider] Received HTTP 422 from Brave. Check query parameters:', error.response?.data || error.message);
        this.error('[BraveSearchProvider] Received HTTP 422 from Brave. Check query parameters:', error.response?.data || error.message);
        throw new SearchError('API_ERROR', 'Received HTTP 422 from Brave.', 'Brave');
      } else if (error.response?.status === 401) {
        console.error('[BraveSearchProvider] Received HTTP 401 Unauthorized. Check API Key.');
        this.error('[BraveSearchProvider] Received HTTP 401 Unauthorized. Check API Key.');
        throw new SearchError('AUTH_ERROR', 'Invalid Brave API Key', 'Brave');
      }
      console.error('[BraveSearchProvider] Unhandled Brave error:', error.message, error.stack);
      this.error('[BraveSearchProvider] Unhandled Brave error:', error.message);
      throw new SearchError('API_ERROR', error.message || 'Brave request failed', 'Brave');
    }
  }

  async search(originalQuery) {
    this.output(`[BraveSearchProvider] Original query: "${originalQuery}"`);
    const sanitizedQuery = originalQuery.trim();
    if (!sanitizedQuery || sanitizedQuery.length < 3) {
      this.output('[BraveSearchProvider] Query too short, skipping search.');
      return [];
    }

    const truncatedQuery = sanitizedQuery.length > 1000 ? sanitizedQuery.substring(0, 1000) : sanitizedQuery;
    if (truncatedQuery.length < sanitizedQuery.length) {
      this.output(`[BraveSearchProvider] Query truncated from ${sanitizedQuery.length} to ${truncatedQuery.length} characters`);
    }

    let retryCount = 0;
    while (retryCount <= this.maxRetries) {
      try {
        const results = await this.makeRequest(truncatedQuery);
        if (results.length === 0) {
          console.error(`[BraveSearchProvider] API returned 0 results for "${truncatedQuery}".`);
          this.error(`[BraveSearchProvider] API returned 0 results for "${truncatedQuery}".`);
        }
        return results;
      } catch (error) {
        if (error instanceof SearchError && error.code === 'AUTH_ERROR') {
          console.error(`[BraveSearchProvider] Authentication error (${error.message}). Aborting search.`);
          this.error(`[BraveSearchProvider] Authentication error (${error.message}). Aborting search.`);
          throw error;
        }
        if (error instanceof SearchError && error.code === 'RATE_LIMIT') {
          const delay = this.retryDelay * Math.pow(2, retryCount);
          this.output(`[BraveSearchProvider] Rate-limited, waiting ${delay / 1000}s before retry (attempt ${retryCount + 1}).`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          retryCount++;
        } else {
          console.error(`[BraveSearchProvider] Unexpected error during search retry loop: ${error.message}`, error.stack);
          this.error(`[BraveSearchProvider] Unexpected error during search retry loop: ${error.message}`);
          throw error;
        }
      }
    }

    console.error('[BraveSearchProvider] Exceeded maximum retries - returning empty result set.');
    this.error('[BraveSearchProvider] Exceeded maximum retries - returning empty result set.');
    throw new SearchError('RATE_LIMIT', 'Exceeded maximum retries due to rate limiting', 'Brave');
  }
}

export function suggestSearchProvider(options = {}) {
  const { type, apiKey = null, outputFn, errorFn } = options; // Add outputFn, errorFn
  if (type === 'web') {
    try {
      return new BraveSearchProvider({ apiKey, outputFn, errorFn }); // Pass outputFn, errorFn
    } catch (error) {
      console.error(`[suggestSearchProvider] Error creating BraveSearchProvider: ${error.message}`);
      throw error;
    }
  }
  throw new SearchError('UnsupportedProvider', `No provider for type: ${type}`, '');
}
