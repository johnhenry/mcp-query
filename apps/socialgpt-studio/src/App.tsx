import { Header } from "./components/Header.js";
import { useNav } from "./nav.js";
import { SearchScreen } from "./screens/Search.js";
import { CreatorScreen } from "./screens/Creator.js";
import { AnalyzeScreen } from "./screens/Analyze.js";
import { VideoScreen } from "./screens/Video.js";

export function App() {
  const { route } = useNav();
  return (
    <div className="app">
      <Header />
      <main className="content">
        {route.screen === "search" && <SearchScreen />}
        {route.screen === "creator" && (
          <CreatorScreen
            platform={route.platform}
            username={route.username}
            accountId={route.accountId}
            name={route.name}
          />
        )}
        {route.screen === "analyze" && (
          <AnalyzeScreen kind={route.kind} platform={route.platform} username={route.username} />
        )}
        {route.screen === "video" && <VideoScreen platform={route.platform} postId={route.postId} title={route.title} />}
      </main>
      <footer className="app-footer">
        <span>SocialGPT Studio · mcp-query example</span>
        <span className="muted">live target: mcp.gpt.social/mcp (via local reverse proxy)</span>
      </footer>
    </div>
  );
}
