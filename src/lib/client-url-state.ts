export type ClientSearchParamUpdates = Record<string, string | null>;

export function buildClientSearchUrl(
  pathname: string,
  currentSearch: string,
  updates: ClientSearchParamUpdates,
): string {
  const params = new URLSearchParams(currentSearch);

  for (const [key, value] of Object.entries(updates)) {
    if (value === null) {
      params.delete(key);
    } else {
      params.set(key, value);
    }
  }

  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function replaceClientSearchParams(
  pathname: string,
  updates: ClientSearchParamUpdates,
): boolean {
  const nextUrl = buildClientSearchUrl(pathname, window.location.search, updates);
  const currentUrl = `${window.location.pathname}${window.location.search}`;

  if (currentUrl === nextUrl) return false;

  window.history.replaceState(null, "", nextUrl);
  return true;
}
