import type { MetadataRoute } from "next";

/**
 * The installed app (platform spec B5) and its share target (intake spec):
 * Android's share sheet posts screenshots to /share-target, where the
 * service worker takes them, so image bytes never pass through a function.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "jobkit",
    short_name: "jobkit",
    description: "Turns a job post into an honest application kit.",
    start_url: "/jobs",
    display: "standalone",
    background_color: "#060607",
    theme_color: "#060607",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    share_target: {
      action: "/share-target",
      method: "POST",
      enctype: "multipart/form-data",
      params: {
        title: "title",
        text: "text",
        url: "url",
        files: [{ name: "images", accept: ["image/*"] }],
      },
    },
  };
}
