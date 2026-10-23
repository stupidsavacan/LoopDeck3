package com.loopdeck3.app;

import java.net.URI;

/** Used by WebView and the native worker. The release origin is pinned at build time. */
public final class CloudPolicy {
    public static final long MAX_ZIP = 32L * 1024 * 1024;
    public static final long CELLULAR_LIMIT = 5L * 1024 * 1024;
    private CloudPolicy() {}
    public static boolean permits(String origin, String url, String method) {
        if (origin == null || origin.isEmpty()) return false;
        try {
            URI trusted = new URI(origin), target = new URI(url);
            if (!"https".equals(trusted.getScheme()) || trusted.getHost() == null || trusted.getRawUserInfo() != null
                    || trusted.getRawQuery() != null || trusted.getRawFragment() != null
                    || !(trusted.getPath().isEmpty() || "/".equals(trusted.getPath()))) return false;
            if (!"https".equals(target.getScheme()) || !trusted.getHost().equalsIgnoreCase(target.getHost())
                    || target.getRawUserInfo() != null || target.getRawFragment() != null
                    || port(trusted) != port(target)) return false;
            String path = target.getRawPath(), query = target.getRawQuery();
            if ("OPTIONS".equals(method)) return permits(origin, url, "GET") || permits(origin, url, "POST");
            if (query != null && !("GET".equals(method) && "/api/v1/packs".equals(path) && query.matches("after=[A-Za-z0-9_.%~+\\-]*"))) return false;
            if ("GET".equals(method)) return path.matches("/api/v1/(health|auth/me|packs)")
                    || path.matches("/api/v1/packs/[A-Za-z0-9_.%~\\-]+/revisions(?:/[0-9]+/download)?");
            return "POST".equals(method) && (path.matches("/api/v1/auth/(login|logout|logout-all)")
                    || path.matches("/api/v1/packs/[A-Za-z0-9_.%~\\-]+/(revisions|restore)"));
        } catch (Exception invalid) { return false; }
    }
    private static int port(URI uri) { return uri.getPort() < 0 ? 443 : uri.getPort(); }
    public static boolean needsWifi(long bytes) { return bytes > CELLULAR_LIMIT; }
}
