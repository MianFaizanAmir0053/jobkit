/**
 * The shared skill vocabulary (extraction spec, "Shared vocabularies"):
 * canonical tags with display names and the aliases posts and CVs use.
 * Extraction normalises requirement tags through it, and the profile seed
 * rejects a fact tag it does not know, so fit checks compare like with like.
 * A new skill is added here, with its aliases, before any profile uses it.
 */
export interface Skill {
  tag: string;
  name: string;
  aliases: readonly string[];
}

export const SKILLS: readonly Skill[] = [
  // Languages
  { tag: "javascript", name: "JavaScript", aliases: ["js", "ecmascript", "es6", "es2015"] },
  { tag: "typescript", name: "TypeScript", aliases: ["ts"] },
  { tag: "python", name: "Python", aliases: ["py", "python3"] },
  { tag: "java", name: "Java", aliases: [] },
  { tag: "kotlin", name: "Kotlin", aliases: [] },
  { tag: "swift", name: "Swift", aliases: [] },
  { tag: "go", name: "Go", aliases: ["golang"] },
  { tag: "rust", name: "Rust", aliases: [] },
  { tag: "csharp", name: "C#", aliases: ["c#", "c sharp"] },
  { tag: "cpp", name: "C++", aliases: ["c++"] },
  { tag: "c", name: "C", aliases: [] },
  { tag: "php", name: "PHP", aliases: [] },
  { tag: "ruby", name: "Ruby", aliases: [] },
  { tag: "dart", name: "Dart", aliases: [] },
  { tag: "sql", name: "SQL", aliases: [] },
  { tag: "html", name: "HTML", aliases: ["html5"] },
  { tag: "css", name: "CSS", aliases: ["css3"] },
  { tag: "sass", name: "Sass", aliases: ["scss"] },
  { tag: "bash", name: "Bash", aliases: ["shell", "shell scripting"] },
  // Front end
  { tag: "react", name: "React", aliases: ["reactjs", "react.js"] },
  { tag: "nextjs", name: "Next.js", aliases: ["next", "next.js"] },
  { tag: "vue", name: "Vue", aliases: ["vuejs", "vue.js"] },
  { tag: "nuxt", name: "Nuxt", aliases: ["nuxtjs", "nuxt.js"] },
  { tag: "angular", name: "Angular", aliases: ["angularjs"] },
  { tag: "svelte", name: "Svelte", aliases: ["sveltekit"] },
  { tag: "redux", name: "Redux", aliases: ["redux toolkit", "rtk"] },
  { tag: "react-query", name: "TanStack Query", aliases: ["tanstack query", "react query"] },
  { tag: "tailwind", name: "Tailwind CSS", aliases: ["tailwindcss", "tailwind css"] },
  { tag: "bootstrap", name: "Bootstrap", aliases: [] },
  { tag: "material-ui", name: "Material UI", aliases: ["mui", "materialui"] },
  { tag: "shadcn", name: "shadcn/ui", aliases: ["shadcn ui", "shadcn/ui"] },
  { tag: "framer-motion", name: "Framer Motion", aliases: ["motion"] },
  { tag: "threejs", name: "Three.js", aliases: ["three", "three.js"] },
  { tag: "webpack", name: "webpack", aliases: [] },
  { tag: "vite", name: "Vite", aliases: [] },
  { tag: "accessibility", name: "Accessibility", aliases: ["a11y", "wcag"] },
  { tag: "responsive-design", name: "Responsive design", aliases: ["responsive web design"] },
  { tag: "seo", name: "SEO", aliases: ["search engine optimization", "search engine optimisation"] },
  { tag: "web-performance", name: "Web performance", aliases: ["core web vitals", "performance optimization"] },
  { tag: "pwa", name: "Progressive web apps", aliases: ["progressive web app", "progressive web apps"] },
  // Mobile
  { tag: "react-native", name: "React Native", aliases: ["reactnative"] },
  { tag: "flutter", name: "Flutter", aliases: [] },
  { tag: "expo", name: "Expo", aliases: [] },
  { tag: "android", name: "Android", aliases: [] },
  { tag: "ios", name: "iOS", aliases: [] },
  // Back end
  { tag: "nodejs", name: "Node.js", aliases: ["node", "node.js"] },
  { tag: "express", name: "Express", aliases: ["expressjs", "express.js"] },
  { tag: "nestjs", name: "NestJS", aliases: ["nest", "nest.js"] },
  { tag: "django", name: "Django", aliases: [] },
  { tag: "flask", name: "Flask", aliases: [] },
  { tag: "fastapi", name: "FastAPI", aliases: [] },
  { tag: "laravel", name: "Laravel", aliases: [] },
  { tag: "rails", name: "Ruby on Rails", aliases: ["ruby on rails", "ror"] },
  { tag: "spring", name: "Spring", aliases: ["spring boot", "springboot"] },
  { tag: "dotnet", name: ".NET", aliases: [".net", "asp.net", "dotnet core", ".net core"] },
  { tag: "rest", name: "REST APIs", aliases: ["restful", "rest api", "rest apis", "restful apis"] },
  { tag: "graphql", name: "GraphQL", aliases: ["apollo"] },
  { tag: "trpc", name: "tRPC", aliases: [] },
  { tag: "websockets", name: "WebSockets", aliases: ["websocket", "socket.io", "socketio"] },
  { tag: "microservices", name: "Microservices", aliases: ["microservice"] },
  { tag: "authentication", name: "Authentication", aliases: ["auth", "oauth", "oauth2", "jwt", "sso"] },
  { tag: "payments", name: "Payments", aliases: ["stripe", "payment integration", "payment gateways"] },
  // Data
  { tag: "postgresql", name: "PostgreSQL", aliases: ["postgres", "psql"] },
  { tag: "mysql", name: "MySQL", aliases: ["mariadb"] },
  { tag: "sqlite", name: "SQLite", aliases: [] },
  { tag: "mongodb", name: "MongoDB", aliases: ["mongo", "mongoose"] },
  { tag: "redis", name: "Redis", aliases: [] },
  { tag: "elasticsearch", name: "Elasticsearch", aliases: ["elastic", "opensearch"] },
  { tag: "firebase", name: "Firebase", aliases: ["firestore"] },
  { tag: "supabase", name: "Supabase", aliases: [] },
  { tag: "prisma", name: "Prisma", aliases: [] },
  { tag: "drizzle", name: "Drizzle", aliases: ["drizzle orm"] },
  { tag: "orm", name: "ORMs", aliases: ["sequelize", "typeorm"] },
  { tag: "data-analysis", name: "Data analysis", aliases: ["pandas", "numpy"] },
  // Cloud and operations
  { tag: "aws", name: "AWS", aliases: ["amazon web services", "ec2", "s3", "lambda"] },
  { tag: "gcp", name: "Google Cloud", aliases: ["google cloud", "google cloud platform"] },
  { tag: "azure", name: "Azure", aliases: ["microsoft azure"] },
  { tag: "vercel", name: "Vercel", aliases: [] },
  { tag: "netlify", name: "Netlify", aliases: [] },
  { tag: "docker", name: "Docker", aliases: ["containers", "containerization", "containerisation"] },
  { tag: "kubernetes", name: "Kubernetes", aliases: ["k8s"] },
  { tag: "terraform", name: "Terraform", aliases: ["infrastructure as code", "iac"] },
  { tag: "ci-cd", name: "CI/CD", aliases: ["ci/cd", "cicd", "continuous integration", "continuous delivery", "continuous deployment"] },
  { tag: "github-actions", name: "GitHub Actions", aliases: [] },
  { tag: "linux", name: "Linux", aliases: ["unix"] },
  { tag: "nginx", name: "Nginx", aliases: [] },
  { tag: "serverless", name: "Serverless", aliases: [] },
  { tag: "monitoring", name: "Monitoring", aliases: ["observability", "sentry", "datadog", "logging"] },
  // Testing and practice
  { tag: "testing", name: "Automated testing", aliases: ["unit testing", "integration testing", "tdd", "test driven development"] },
  { tag: "jest", name: "Jest", aliases: [] },
  { tag: "vitest", name: "Vitest", aliases: [] },
  { tag: "testing-library", name: "Testing Library", aliases: ["react testing library", "rtl"] },
  { tag: "cypress", name: "Cypress", aliases: [] },
  { tag: "playwright", name: "Playwright", aliases: [] },
  { tag: "git", name: "Git", aliases: ["github", "gitlab", "bitbucket", "version control"] },
  { tag: "agile", name: "Agile", aliases: ["scrum", "kanban"] },
  { tag: "system-design", name: "System design", aliases: ["software architecture", "architecture"] },
  { tag: "security", name: "Web security", aliases: ["owasp", "application security", "appsec"] },
  // Design and AI
  { tag: "figma", name: "Figma", aliases: [] },
  { tag: "ui-design", name: "UI design", aliases: ["ui/ux", "ux", "user interface design"] },
  { tag: "llm", name: "LLM applications", aliases: ["llms", "large language models", "genai", "generative ai", "openai", "anthropic", "claude", "langchain"] },
  { tag: "rag", name: "Retrieval-augmented generation", aliases: ["retrieval augmented generation", "vector search", "embeddings"] },
  { tag: "machine-learning", name: "Machine learning", aliases: ["ml", "deep learning", "pytorch", "tensorflow"] },
  // Content platforms
  { tag: "wordpress", name: "WordPress", aliases: ["wp"] },
  { tag: "shopify", name: "Shopify", aliases: ["liquid"] },
  { tag: "headless-cms", name: "Headless CMS", aliases: ["sanity", "contentful", "strapi"] },
  // Spoken languages
  { tag: "english", name: "English", aliases: [] },
  { tag: "urdu", name: "Urdu", aliases: [] },
  { tag: "arabic", name: "Arabic", aliases: [] },
];

/** Lower case, with spaces, dots, hyphens, underscores and slashes dropped: "Next.js" and "next js" meet. */
function lookupKey(text: string): string {
  return text.toLowerCase().replace(/[\s._/-]+/g, "");
}

const BY_KEY: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const skill of SKILLS) {
    for (const name of [skill.tag, skill.name, ...skill.aliases]) {
      const key = lookupKey(name);
      const taken = map.get(key);
      if (taken !== undefined && taken !== skill.tag) {
        throw new Error(`"${name}" names both ${taken} and ${skill.tag} in the skill vocabulary`);
      }
      map.set(key, skill.tag);
    }
  }
  return map;
})();

const TAGS: ReadonlyMap<string, Skill> = new Map(SKILLS.map((skill) => [skill.tag, skill]));

/** The canonical tag for a skill as written, or null when the vocabulary does not know it. */
export function skillTag(text: string): string | null {
  return BY_KEY.get(lookupKey(text)) ?? null;
}

export function isSkillTag(tag: string): boolean {
  return TAGS.has(tag);
}

/** How a tag is shown, such as "Next.js" for nextjs. */
export function skillName(tag: string): string {
  return TAGS.get(tag)?.name ?? tag;
}
