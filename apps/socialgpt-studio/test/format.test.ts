import { describe, it, expect } from "vitest";
import { videoRef, creatorRef, viewCount, asSeries, mergeFill, latestSeriesPoint } from "../src/lib/format.js";

// Fixtures captured from the LIVE SocialGPT server (mcp.gpt.social) — the real shapes the
// extraction helpers must handle: nested `metadata` (search), nested `metrics` (videos), and
// series nested under `series.<platform>` (history).

const SEARCH_ROW = {
  id: "socialgpt-post:tiktok:7492198578958388522",
  title: "Black Mirror S07E01 stopped me in my tracks. ",
  url: "https://www.tiktok.com/@notjohnhenry/video/7492198578958388522",
  text: "Black Mirror S07E01 stopped me in my tracks.",
  metadata: { platform: "tiktok", post_id: "7492198578958388522", creator_username: "notjohnhenry", owned_by_user: true },
};

const VIDEO_ROW = {
  id: "socialgpt-post:tiktok:7636843466940583181",
  platform: "tiktok",
  post_id: "7636843466940583181",
  title: "",
  caption: "",
  post_url: "https://www.tiktok.com/@notjohnhenry/video/7636843466940583181",
  thumbnail_url: "https://example/thumb.webp",
  creator_username: "notjohnhenry",
  metrics: { views: 11, likes: 0, comments: 0, shares: 0, saves: 0, engagement_rate: 0 },
};

const ACCOUNT_ROW = {
  account_id: "c365e977-b72e-47db-be03-45222f81e2f1",
  platform: "instagram",
  username: "iamnotjohnhenry",
  display_name: "John Henry",
  profile_picture_url: "https://example/pic.jpg",
  profile_link: "https://instagram.com/iamnotjohnhenry",
  is_verified: false,
};

const SPARSE_CREATOR = {
  creator_id: "361286cf",
  platform: "instagram",
  username: "iamnotjohnhenry",
  display_name: null,
  bio: null,
  profile_picture_url: null,
  follower_count: null,
};

const FOLLOWER_HISTORY = {
  account_id: "f7c262d3",
  platform: "tiktok",
  series: {
    tiktok: [
      { timestamp: "2026-06-18T23:00:10Z", follower_count: 27, like_count: 81, views: 2178, bucket: "2026-06-18" },
      { timestamp: "2026-06-19T23:03:04Z", follower_count: 28, like_count: 81, views: 2200, bucket: "2026-06-19" },
    ],
  },
};

describe("videoRef — nested metadata + top-level", () => {
  it("extracts platform/post_id/username from a `search` row (nested metadata)", () => {
    const r = videoRef(SEARCH_ROW);
    expect(r).toEqual({ platform: "tiktok", postId: "7492198578958388522", title: expect.any(String), username: "notjohnhenry" });
  });
  it("extracts from a list_creator_videos row (top-level)", () => {
    const r = videoRef(VIDEO_ROW);
    expect(r?.platform).toBe("tiktok");
    expect(r?.postId).toBe("7636843466940583181");
    expect(r?.username).toBe("notjohnhenry");
  });
  it("falls back to splitting a composite id when no post_id", () => {
    const r = videoRef({ id: "socialgpt-post:tiktok:999", platform: "tiktok" });
    expect(r?.postId).toBe("999");
  });
});

describe("viewCount — nested metrics", () => {
  it("reads views out of the nested metrics object", () => {
    expect(viewCount(VIDEO_ROW)).toBe("11");
  });
  it("returns undefined when no metrics", () => {
    expect(viewCount({ platform: "tiktok" })).toBeUndefined();
  });
});

describe("creatorRef", () => {
  it("pulls identity from an account row", () => {
    expect(creatorRef(ACCOUNT_ROW)).toEqual({
      platform: "instagram",
      username: "iamnotjohnhenry",
      accountId: "c365e977-b72e-47db-be03-45222f81e2f1",
      name: "John Henry",
    });
  });
});

describe("asSeries — series nested under platform key", () => {
  it("flattens series.<platform> and charts follower_count", () => {
    const s = asSeries(FOLLOWER_HISTORY, ["follower_count"]);
    expect(s).toEqual([
      { label: "2026-06-18", value: 27 },
      { label: "2026-06-19", value: 28 },
    ]);
  });
  it("coerces numeric-string metrics", () => {
    const s = asSeries(FOLLOWER_HISTORY, ["like_count"]);
    expect(s.map((p) => p.value)).toEqual([81, 81]);
  });
});

describe("mergeFill — sparse get_creator backfilled by account", () => {
  it("keeps account avatar/name when get_creator returns nulls", () => {
    const merged = mergeFill(ACCOUNT_ROW, SPARSE_CREATOR);
    expect(merged.profile_picture_url).toBe("https://example/pic.jpg"); // null in creator → account wins
    expect(merged.display_name).toBe("John Henry");
    expect(merged.creator_id).toBe("361286cf"); // non-null creator field applied
  });
});

describe("latestSeriesPoint", () => {
  it("returns the most recent row", () => {
    expect(latestSeriesPoint(FOLLOWER_HISTORY)?.follower_count).toBe(28);
  });
});
