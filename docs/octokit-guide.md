# TypeScript/Bun 기반 GitHub GraphQL 가이드

##  의존성 확인 및 설치

본 프로젝트에 이미 `@octokit/graphql`이 등록되어 있으므로 별도 설치 없이 아래 명령으로 의존성을 설치합니다.

```bash
bun install
```

---

## . 기본 설정

`index.ts` 또는 별도 파일에 GitHub GraphQL 클라이언트를 설정합니다.

```ts
import { graphql } from "@octokit/graphql";

const githubGraphQL = graphql.defaults({
  headers: {
    authorization: `token ${Bun.env.GITHUB_TOKEN}`,
  },
});
```

토큰은 코드에 직접 쓰지 않고 환경 변수(`GITHUB_TOKEN`)로 설정합니다.

```bash
GITHUB_TOKEN=your_token bun run index.ts
```

---

## . TypeScript 인터페이스로 응답 타입 정의

GraphQL 응답 구조에 맞춰 타입을 정의합니다.

```ts
interface Author {
  login: string;
}

interface Issue {
  title: string;
  url: string;
  author: Author | null;
}

interface PullRequest {
  title: string;
  url: string;
  author: Author | null;
}

interface IssuesResponse {
  repository: {
    issues: {
      nodes: Issue[];
    };
  };
}

interface PullRequestsResponse {
  repository: {
    pullRequests: {
      nodes: PullRequest[];
    };
  };
}
```

---

## 4-1. Issue 조회 예시

```ts
const result = await githubGraphQL<IssuesResponse>(
  `
  query($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {
      issues(first: 10, states: OPEN) {
        nodes {
          title
          url
          author {
            login
          }
        }
      }
    }
  }
  `,
  {
    owner: "oss2025hnu",
    repo: "reposcore-cs",
  }
);

console.log(result.repository.issues.nodes);
```

---

## 4-2. Pull Request 조회 예시

```ts
const result = await githubGraphQL<PullRequestsResponse>(
  `
  query($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {
      pullRequests(first: 10, states: OPEN) {
        nodes {
          title
          url
          author {
            login
          }
        }
      }
    }
  }
  `,
  {
    owner: "oss2025hnu",
    repo: "reposcore-cs",
  }
);

console.log(result.repository.pullRequests.nodes);
```

---

## 4-3. Issue + PR 통합 조회

```ts
const result = await githubGraphQL(
  `
  query($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {
      issues(first: 10) {
        nodes {
          author { login }
        }
      }
      pullRequests(first: 10) {
        nodes {
          author { login }
        }
      }
    }
  }
  `,
  {
    owner: "oss2025hnu",
    repo: "reposcore-cs",
  }
);
```

---

## 5. 참고 문서

* GitHub GraphQL API
  [https://docs.github.com/graphql](https://docs.github.com/graphql)

* GraphQL 기본 개념
  [https://graphql.org/learn/](https://graphql.org/learn/)

---
