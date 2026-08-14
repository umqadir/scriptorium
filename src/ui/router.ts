/** Minimal hash router. No history API tricks — GitHub Pages friendly. */

export type Route =
  | { name: "library" }
  | { name: "reader"; bookId: string }
  | { name: "settings" }
  | { name: "import" };

export function parseHash(hash: string): Route {
  const clean = hash.replace(/^#\/?/, "");
  const [head, ...rest] = clean.split("/").filter(Boolean);
  switch (head) {
    case "reader": {
      const bookId = rest[0];
      if (bookId) return { name: "reader", bookId: decodeURIComponent(bookId) };
      return { name: "library" };
    }
    case "settings":
      return { name: "settings" };
    case "import":
      return { name: "import" };
    case "library":
    case undefined:
    case "":
      return { name: "library" };
    default:
      return { name: "library" };
  }
}

export function routeToHash(route: Route): string {
  switch (route.name) {
    case "library":
      return "#/library";
    case "reader":
      return `#/reader/${encodeURIComponent(route.bookId)}`;
    case "settings":
      return "#/settings";
    case "import":
      return "#/import";
  }
}

export function navigate(route: Route): void {
  const hash = routeToHash(route);
  if (location.hash !== hash) {
    location.hash = hash;
  } else {
    // Same route requested again (e.g. re-clicking a nav item) — force a
    // handler run since hashchange won't fire.
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }
}

export function onRouteChange(handler: (route: Route) => void): () => void {
  const listener = () => handler(parseHash(location.hash));
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}

export function currentRoute(): Route {
  return parseHash(location.hash);
}
