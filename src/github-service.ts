import {graphql} from '@octokit/graphql';

import type {
  ContributionLabel,
  DetailedRepoData,
  ClaimInfo,
  ClaimsIssueNode,
  ClaimsData,
  RepoClaims,
  IssueRecord,
  PRRecord,
} from './types';

import {loadCache, saveCache} from './cache';

interface ClaimsPageResponse {
  repository: {
    issues: {
      nodes: {
        number: number;
        title: string;
        url: string;
        labels: {nodes: {name: string}[]};
        comments: {
          nodes: {
            body: string;
            author: {login: string} | null;
            createdAt: string;
          }[];
        };
      }[];
      pageInfo: PageInfo;
    };
  };
}

interface OpenPrPageResponse {
  repository: {
    pullRequests: {
      nodes: {
        number: number;
        url: string;
        body: string | null;
      }[];
      pageInfo: PageInfo;
    };
  };
}

interface ClaimsSearchResponse {
  search: {
    nodes: Array<{
      number: number;
      title: string;
      url: string;
      state: string;
      labels: {nodes: {name: string}[]};
      comments: {
        nodes: {
          body: string;
          author: {login: string} | null;
          createdAt: string;
        }[];
      };
    }>;
    pageInfo: PageInfo;
  };
}

type RawIssue = Omit<IssueRecord, 'category'>;
type RawPullRequest = Omit<PRRecord, 'category'>;

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface IssuePageResponse {
  repository: {
    issues: {
      nodes: (RawIssue & {stateReason: string | null})[];
      pageInfo: PageInfo;
    };
  };
}

interface PullRequestPageResponse {
  repository: {
    pullRequests: {
      nodes: RawPullRequest[];
      pageInfo: PageInfo;
    };
  };
}

interface IssueSearchResponse {
  search: {
    nodes: (RawIssue & {stateReason: string | null})[];
    pageInfo: PageInfo;
  };
}

interface PullRequestSearchResponse {
  search: {
    nodes: RawPullRequest[];
    pageInfo: PageInfo;
  };
}

interface GetDetailedRepoDataOptions {
  since?: string;
}

const PAGE_SIZE = 100;

/**
 * GitHub API 호출 중 발생한 오류를 사용자 친화적인 메시지로 변환합니다.
 * 인증 실패(401)와 요청 한도 초과(403/429)는 구체적인 안내로,
 * 그 외 오류는 raw 스택 트레이스 대신 정리된 메시지로 변환합니다.
 * @param error 발생한 오류 객체
 * @returns 사용자에게 출력할 오류 메시지
 */
export const formatGitHubApiError = (error: unknown): string => {
  const status = (error as {status?: number} | null)?.status;

  if (status === 401) {
    return '오류: GitHub API 인증에 실패했습니다. GITHUB_TOKEN 또는 --token 값을 확인하세요. (Status: 401)';
  }

  if (status === 403 || status === 429) {
    return `오류: GitHub API 요청 한도를 초과했습니다. 잠시 후 다시 시도하세요. (Status: ${status})`;
  }

  const message = error instanceof Error ? error.message : String(error);
  return `오류: 저장소 검증 중 GitHub API 오류가 발생했습니다. (${message})`;
};

export const normalizeWhitespace = (text: string): string =>
  text.replace(/\s+/g, '').toLowerCase();

// [긴급 조치] 복사 인코딩 오류 및 개행 문자 깨짐을 우회하기 위해 정규식을 안전한 RegExp 생성자 문자열 구조로 전면 전향
const HTML_COMMENT_PATTERN = new RegExp('', 'g');

/**
 * 🌟 [이슈 해결] owner/repo#번호 형식까지 완벽하게 추출하도록 3번째 매칭 그룹 추가 완료
 * 1. #(\d+) -> match[1]
 * 2. issues/(\d+) -> match[2]
 * 3. [^/\s]+/[^/\s]+#(\d+) -> match[3] (owner/repo#123 형태 타겟팅)
 */
const CLOSING_ISSUE_PATTERN = new RegExp(
  '\\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\\s+(?:#(\\d+)|https://github\\.com/[^/\\s]+/[^/\\s]+/issues/(\\d+)|[^/\\s]+/[^/\\s]+#(\\d+))\\b',
  'gi',
);

/**
 * PR 본문에서 실제 GitHub closing keyword가 붙은 이슈 번호만 추출합니다.
 * PR 템플릿의 HTML 주석 예시 번호나 단순 참고용 #번호는 제외합니다.
 */
export const parseClosingIssueNumbers = (body: string): number[] => {
  const issueNumbers = new Set<number>();
  const bodyWithoutComments = body.replace(HTML_COMMENT_PATTERN, '');

  for (const match of bodyWithoutComments.matchAll(CLOSING_ISSUE_PATTERN)) {
    // 🌟 match[1], match[2], match[3] 중 가장 먼저 매칭된 값을 가져와서 에러를 원천 차단
    const matchedNumberStr = match[1] ?? match[2] ?? match[3];
    const issueNumber = Number(matchedNumberStr);

    if (Number.isInteger(issueNumber)) {
      issueNumbers.add(issueNumber);
    }
  }

  return [...issueNumbers];
};

/**
 * GitHub 라벨명을 내부 기여 카테고리로 정규화합니다.
 * @param label 정규화할 GitHub 라벨명
 * @returns 정규화된 기여 카테고리
 */
export const normalizeLabel = (label: string): ContributionLabel => {
  const key = label.toLowerCase().replace(/[-_\s]/g, '');
  if (key === 'feat' || key === 'feature' || key === 'enhancement')
    return 'feature';
  if (key === 'bug') return 'bug';
  if (key === 'doc' || key === 'docs' || key === 'documentation') return 'doc';
  if (key === 'typo') return 'typo';
  return 'none';
};

/**
 * 여러 라벨 중 기여 카테고리에 해당하는 첫 번째 라벨을 찾습니다.
 * @param labels GitHub 라벨명 목록
 * @returns 분류된 기여 카테고리
 */
export const categorizeLabels = (labels: string[]): ContributionLabel => {
  for (const label of labels) {
    const category = normalizeLabel(label);
    if (category !== 'none') {
      return category;
    }
  }

  return 'none';
};

/**
 * GitHub 라벨 노드 목록에서 라벨명만 추출합니다.
 * @param labels GitHub GraphQL 응답의 라벨 노드 목록
 * @returns 라벨명 문자열 배열
 */
const extractLabelNames = (labels: {nodes: {name: string}[]}): string[] =>
  labels.nodes.map(node => node.name).filter(name => Boolean(name));

/**
 * GitHub Issue 원본 데이터를 내부 IssueRecord 형식으로 변환합니다.
 * @param raw GitHub GraphQL 응답에서 가져온 Issue 데이터
 * @returns 내부에서 사용하는 IssueRecord 객체
 */
const toIssueRecord = (
  raw: RawIssue & {stateReason?: string | null},
): IssueRecord => {
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    state: raw.state,
    createdAt: raw.createdAt,
    closedAt: raw.closedAt,
    author: raw.author,
    labels: raw.labels,
    category: categorizeLabels(extractLabelNames(raw.labels)),
  };
};

/**
 * GitHub Pull Request 원본 데이터를 내부 PRRecord 형식으로 변환합니다.
 * @param raw GitHub GraphQL 응답에서 가져온 Pull Request 데이터
 * @returns 내부에서 사용하는 PRRecord 객체
 */
const toPrRecord = (raw: RawPullRequest): PRRecord => {
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    merged: raw.merged,
    mergedAt: raw.mergedAt,
    additions: raw.additions,
    deletions: raw.deletions,
    author: raw.author,
    labels: raw.labels,
    category: categorizeLabels(extractLabelNames(raw.labels)),
  };
};

/**
 * 번호를 기준으로 기존 캐시 데이터와 새로 조회한 데이터를 병합합니다.
 * @param cachedItems 캐시에 저장되어 있던 기존 항목 목록
 * @param updatedItems 새로 조회한 최신 항목 목록
 * @returns 번호 기준으로 병합된 항목 목록
 */
const mergeByNumber = <T extends {number: number}>(
  cachedItems: T[],
  updatedItems: T[],
): T[] => {
  const itemMap = new Map<number, T>();

  for (const item of cachedItems) {
    itemMap.set(item.number, item);
  }

  for (const item of updatedItems) {
    itemMap.set(item.number, item);
  }

  return [...itemMap.values()].sort((a, b) => b.number - a.number);
};

/**
 * 기여 카테고리별 개수를 나타내는 객체입니다.
 */
export interface CategoryCounts {
  feature: number;
  bug: number;
  doc: number;
  typo: number;
  none: number;
}

/**
 * 기여 기록 목록을 카테고리별로 집계합니다.
 * @param records 카테고리 정보가 포함된 기여 기록 목록
 * @returns 카테고리별 개수
 */
export const countByCategory = (
  records: ReadonlyArray<{category: ContributionLabel}>,
): CategoryCounts => {
  const counts: CategoryCounts = {
    feature: 0,
    bug: 0,
    doc: 0,
    typo: 0,
    none: 0,
  };

  for (const record of records) {
    counts[record.category] += 1;
  }

  return counts;
};

/**
 * GitHub GraphQL API를 사용하는 서비스 객체를 생성합니다.
 * @param token GitHub Personal Access Token
 * @param pageSize 한 번에 가져올 항목 수 (기본값: 100)
 * @returns 저장소 상세 데이터, 이슈 선점 현황, 저장소 존재 검증 기능을 제공하는 서비스 객체
 */
export const createGitHubService = (token: string, pageSize = PAGE_SIZE) => {
  const githubGraphQL = graphql.defaults({
    headers: {
      authorization: `token ${token}`,
    },
  });

  /**
   * 저장소의 유효한 이슈를 모두 조회합니다.
   * OPEN 상태이거나 완료 처리된 이슈만 수집합니다.
   * @param owner 저장소 소유자
   * @param repo 저장소 이름
   * @returns 유효한 이슈 목록
   */
  const getAllValidIssues = async (
    owner: string,
    repo: string,
  ): Promise<IssueRecord[]> => {
    const issues: IssueRecord[] = [];
    let cursor: string | null = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const response: IssuePageResponse =
        await githubGraphQL<IssuePageResponse>(
          `
          query(
            $owner: String!
            $repo: String!
            $pageSize: Int!
            $cursor: String
          ) {
            repository(owner: $owner, name: $repo) {
              issues(
                first: $pageSize
                after: $cursor
                orderBy: {field: CREATED_AT, direction: DESC}
              ) {
                nodes {
                  number
                  title
                  url
                  state
                  stateReason
                  createdAt
                  closedAt
                  author { login }
                  labels(first: 20) { nodes { name } }
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
          `,
          {owner, repo, pageSize, cursor},
        );

      const connection: IssuePageResponse['repository']['issues'] =
        response.repository.issues;

      const validNodes = connection.nodes.filter(
        (node: RawIssue & {stateReason: string | null}) =>
          node.state === 'OPEN' || node.stateReason === 'COMPLETED',
      );

      issues.push(...validNodes.map(toIssueRecord));

      cursor = connection.pageInfo.endCursor;
      hasNextPage = connection.pageInfo.hasNextPage && cursor !== null;
    }

    return issues;
  };

  /**
   * 저장소의 병합된 Pull Request를 모두 조회합니다.
   * @param owner 저장소 소유자
   * @param repo 저장소 이름
   * @returns 병합된 Pull Request 목록
   */
  const getAllMergedPullRequests = async (
    owner: string,
    repo: string,
  ): Promise<PRRecord[]> => {
    const prs: PRRecord[] = [];
    let cursor: string | null = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const response: PullRequestPageResponse =
        await githubGraphQL<PullRequestPageResponse>(
          `
          query(
            $owner: String!
            $repo: String!
            $pageSize: Int!
            $cursor: String
          ) {
            repository(owner: $owner, name: $repo) {
              pullRequests(
                first: $pageSize
                after: $cursor
                states: MERGED
                orderBy: {field: CREATED_AT, direction: DESC}
              ) {
                nodes {
                  number
                  title
                  url
                  merged
                  mergedAt
                  additions
                  deletions
                  author { login }
                  labels(first: 20) { nodes { name } }
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
          `,
          {owner, repo, pageSize, cursor},
        );

      const connection: PullRequestPageResponse['repository']['pullRequests'] =
        response.repository.pullRequests;

      prs.push(...connection.nodes.map(toPrRecord));

      cursor = connection.pageInfo.endCursor;
      hasNextPage = connection.pageInfo.hasNextPage && cursor !== null;
    }

    return prs;
  };

  /**
   * 지정한 시점 이후 변경된 유효 이슈를 조회합니다.
   * OPEN 상태이거나 완료 처리된 이슈만 수집합니다.
   * @param owner 저장소 소유자
   * @param repo 저장소 이름
   * @param since 변경 내역을 조회할 기준 시각
   * @returns 기준 시각 이후 변경된 유효 이슈 목록
   */
  const getUpdatedValidIssues = async (
    owner: string,
    repo: string,
    since: string,
  ): Promise<IssueRecord[]> => {
    const issues: IssueRecord[] = [];
    let cursor: string | null = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const response: IssueSearchResponse =
        await githubGraphQL<IssueSearchResponse>(
          `
          query(
            $searchQuery: String!
            $pageSize: Int!
            $cursor: String
          ) {
            search(
              query: $searchQuery
              type: ISSUE
              first: $pageSize
              after: $cursor
            ) {
              nodes {
                ... on Issue {
                  number
                  title
                  url
                  state
                  stateReason
                  createdAt
                  closedAt
                  author { login }
                  labels(first: 20) { nodes { name } }
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
          `,
          {
            searchQuery: `repo:${owner}/${repo} is:issue updated:>=${since}`,
            pageSize,
            cursor,
          },
        );

      const validNodes = response.search.nodes.filter(
        (node: RawIssue & {stateReason: string | null}) =>
          node.state === 'OPEN' || node.stateReason === 'COMPLETED',
      );

      issues.push(...validNodes.map(toIssueRecord));

      cursor = response.search.pageInfo.endCursor;
      hasNextPage = response.search.pageInfo.hasNextPage && cursor !== null;
    }

    return issues;
  };

  /**
   * 지정한 시점 이후 변경된 병합 Pull Request를 조회합니다.
   * @param owner 저장소 소유자
   * @param repo 저장소 이름
   * @param since 변경 내역을 조회할 기준 시각
   * @returns 기준 시각 이후 변경된 병합 Pull Request 목록
   */
  const getUpdatedMergedPullRequests = async (
    owner: string,
    repo: string,
    since: string,
  ): Promise<PRRecord[]> => {
    const prs: PRRecord[] = [];
    let cursor: string | null = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const response: PullRequestSearchResponse =
        await githubGraphQL<PullRequestSearchResponse>(
          `
          query(
            $searchQuery: String!
            $pageSize: Int!
            $cursor: String
          ) {
            search(
              query: $searchQuery
              type: ISSUE
              first: $pageSize
              after: $cursor
            ) {
              nodes {
                ... on PullRequest {
                  number
                  title
                  url
                  merged
                  mergedAt
                  additions
                  deletions
                  author { login }
                  labels(first: 20) { nodes { name } }
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
          `,
          {
            searchQuery: `repo:${owner}/${repo} is:pr is:merged updated:>=${since}`,
            pageSize,
            cursor,
          },
        );

      prs.push(...response.search.nodes.map(toPrRecord));

      cursor = response.search.pageInfo.endCursor;
      hasNextPage = response.search.pageInfo.hasNextPage && cursor !== null;
    }

    return prs;
  };

  /**
   * 저장소의 이슈와 병합된 Pull Request 상세 데이터를 조회합니다.
   * 캐시가 있으면 마지막 분석 시점 이후의 변경분만 조회해 병합하고,
   * 캐시가 없으면 전체 데이터를 새로 수집합니다.
   * @param owner 저장소 소유자
   * @param repo 저장소 이름
   * @param useCache 캐시 사용 여부
   * @returns 저장소의 상세 기여 데이터
   */
  const getDetailedRepoData = async (
    owner: string,
    repo: string,
    useCache = true,
    options?: GetDetailedRepoDataOptions,
  ): Promise<DetailedRepoData> => {
    const analysisStartedAt = new Date().toISOString();
    const cached = await loadCache<DetailedRepoData>(owner, repo, !useCache);

    // [버그 수정 완료 블록] 캐시가 없는 상태이거나 --no-cache 일 때 options.since를 검사하여 데이터 필터링 적용
    if (!cached) {
      const [issues, prs] = await Promise.all([
        options?.since
          ? getUpdatedValidIssues(owner, repo, options.since)
          : getAllValidIssues(owner, repo),
        options?.since
          ? getUpdatedMergedPullRequests(owner, repo, options.since)
          : getAllMergedPullRequests(owner, repo),
      ]);

      const data: DetailedRepoData = {
        prs,
        issues,
      };

      await saveCache(owner, repo, data, analysisStartedAt);

      return data;
    }

    // 캐시가 존재할 때 기존 점진적 수집 흐름
    const since = options?.since ?? cached.lastAnalyzedAt;

    const [updatedIssues, updatedPrs] = await Promise.all([
      getUpdatedValidIssues(owner, repo, since),
      getUpdatedMergedPullRequests(owner, repo, since),
    ]);

    const data: DetailedRepoData = {
      prs: mergeByNumber(cached.data.prs, updatedPrs),
      issues: mergeByNumber(cached.data.issues, updatedIssues),
    };

    await saveCache(owner, repo, data, analysisStartedAt);

    return data;
  };

  /**
   * 저장소의 열린 PR 본문에서 이슈 번호를 파싱해 이슈 번호 → 열린 PR 매핑을 반환합니다.
   * @param owner 저장소 소유자
   * @param repo 저장소 이름
   * @returns 이슈 번호 → {number, url} 열린 PR 매핑
   */
  const getOpenPrIssueMap = async (
    owner: string,
    repo: string,
  ): Promise<Map<number, {number: number; url: string}>> => {
    const issueToOpenPr = new Map<number, {number: number; url: string}>();
    let cursor: string | null = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const response: OpenPrPageResponse =
        await githubGraphQL<OpenPrPageResponse>(
          `
          query($owner: String!, $repo: String!, $pageSize: Int!, $cursor: String) {
            repository(owner: $owner, name: $repo) {
              pullRequests(first: $pageSize, after: $cursor, states: OPEN) {
                nodes {
                  number
                  url
                  body
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
          `,
          {owner, repo, pageSize, cursor},
        );

      const connection = response.repository.pullRequests;

      for (const pr of connection.nodes) {
        const issueNumbers = parseClosingIssueNumbers(pr.body ?? '');
        for (const issueNum of issueNumbers) {
          if (!issueToOpenPr.has(issueNum)) {
            issueToOpenPr.set(issueNum, {number: pr.number, url: pr.url});
          }
        }
      }

      cursor = connection.pageInfo.endCursor;
      hasNextPage = connection.pageInfo.hasNextPage && cursor !== null;
    }

    return issueToOpenPr;
  };

  /**
   * 저장소의 열린 이슈와 최근 댓글을 모두 조회합니다 (전체 조회).
   * @param owner 저장소 소유자
   * @param repo 저장소 이름
   * @returns 열린 이슈 목록 (댓글 포함)
   */
  const getAllOpenIssuesWithComments = async (
    owner: string,
    repo: string,
  ): Promise<ClaimsIssueNode[]> => {
    const issues: ClaimsIssueNode[] = [];
    let cursor: string | null = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const response: ClaimsPageResponse =
        await githubGraphQL<ClaimsPageResponse>(
          `
          query($owner: String!, $repo: String!, $pageSize: Int!, $cursor: String) {
            repository(owner: $owner, name: $repo) {
              issues(first: $pageSize, after: $cursor, states: OPEN, orderBy: {field: CREATED_AT, direction: DESC}) {
                nodes {
                  number
                  title
                  url
                  labels(first: 20) { nodes { name } }
                  comments(last: 10) {
                    nodes {
                      body
                      author { login }
                      createdAt
                    }
                  }
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
          `,
          {owner, repo, pageSize, cursor},
        );

      const connection = response.repository.issues;
      issues.push(...connection.nodes);

      cursor = connection.pageInfo.endCursor;
      hasNextPage = connection.pageInfo.hasNextPage && cursor !== null;
    }

    return issues;
  };

  /**
   * 지정한 시점 이후 변경된 이슈(열림/닫힘 모두)와 최근 댓글을 조회합니다 (증분 조회).
   * @param owner 저장소 소유자
   * @param repo 저장소 이름
   * @param since 변경 내역을 조회할 기준 시각
   * @returns 기준 시각 이후 변경된 이슈 목록 (state 포함, 댓글 포함)
   */
  const getUpdatedIssuesWithComments = async (
    owner: string,
    repo: string,
    since: string,
  ): Promise<Array<ClaimsIssueNode & {state: string}>> => {
    const issues: Array<ClaimsIssueNode & {state: string}> = [];
    let cursor: string | null = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const response: ClaimsSearchResponse =
        await githubGraphQL<ClaimsSearchResponse>(
          `
          query($searchQuery: String!, $pageSize: Int!, $cursor: String) {
            search(query: $searchQuery, type: ISSUE, first: $pageSize, after: $cursor) {
              nodes {
                ... on Issue {
                  number
                  title
                  url
                  state
                  labels(first: 20) { nodes { name } }
                  comments(last: 10) {
                    nodes {
                      body
                      author { login }
                      createdAt
                    }
                  }
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
          `,
          {
            searchQuery: `repo:${owner}/${repo} is:issue updated:>=${since}`,
            pageSize,
            cursor,
          },
        );

      issues.push(...response.search.nodes);

      cursor = response.search.pageInfo.endCursor;
      hasNextPage = response.search.pageInfo.hasNextPage && cursor !== null;
    }

    return issues;
  };

  /**
   * 열린 이슈와 최근 댓글을 조회하여 선점 키워드가 포함된 이슈를 분류합니다.
   * 캐시가 있으면 마지막 분석 시점 이후의 변경분만 조회해 병합하고,
   * 캐시가 없으면 전체 데이터를 새로 수집합니다.
   * @param owner 저장소 소유자
   * @param repo 저장소 이름
   * @param keywords 선점 여부를 판단할 키워드 목록
   * @param repoPath 출력에 사용할 저장소 경로
   * @param useCache 캐시 사용 여부
   * @returns 선점된 이슈와 선점되지 않은 이슈 목록
   */
  const getRecentClaimsData = async (
    owner: string,
    repo: string,
    keywords: string[],
    repoPath: string,
    useCache = true,
  ): Promise<RepoClaims> => {
    const analysisStartedAt = new Date().toISOString();
    const cached = await loadCache<ClaimsData>(
      owner,
      repo,
      !useCache,
      'claims-cache',
    );

    const [issueToOpenPr, openIssuesResult] = await (cached
      ? Promise.all([
          getOpenPrIssueMap(owner, repo),
          getUpdatedIssuesWithComments(owner, repo, cached.lastAnalyzedAt),
        ])
      : Promise.all([
          getOpenPrIssueMap(owner, repo),
          getAllOpenIssuesWithComments(owner, repo),
        ]));

    let openIssues: ClaimsIssueNode[];

    if (!cached) {
      openIssues = openIssuesResult as ClaimsIssueNode[];
    } else {
      const updatedIssues = openIssuesResult as Array<
        ClaimsIssueNode & {state: string}
      >;

      // 닫힌 이슈 번호 집합 — 캐시에서 제거 대상
      const closedNumbers = new Set(
        updatedIssues.filter(i => i.state === 'CLOSED').map(i => i.number),
      );

      // 캐시에서 닫힌 이슈 제거
      const filteredCached = cached.data.issues.filter(
        i => !closedNumbers.has(i.number),
      );

      // 업데이트된 열린 이슈만 추출 (state 필드 제거)
      const openUpdated: ClaimsIssueNode[] = updatedIssues
        .filter(i => i.state === 'OPEN')
        .map(({number, title, url, labels, comments}) => ({
          number,
          title,
          url,
          labels,
          comments,
        }));

      openIssues = mergeByNumber(filteredCached, openUpdated);
    }

    await saveCache<ClaimsData>(
      owner,
      repo,
      {issues: openIssues},
      analysisStartedAt,
      'claims-cache',
    );

    const claimed: ClaimInfo[] = [];
    const unclaimed: ClaimInfo[] = [];

    for (const node of openIssues) {
      let matchedClaim: {
        claimer: string;
        keyword: string;
        createdAt: string;
      } | null = null;

      const comments = [...node.comments.nodes].reverse();
      const now = Date.now();
      const issueCategory = categorizeLabels(extractLabelNames(node.labels));
      const CLAIM_WINDOW_MS =
        issueCategory === 'doc' ? 24 * 60 * 60 * 1000 : 48 * 60 * 60 * 1000;

      for (const comment of comments) {
        if (now - new Date(comment.createdAt).getTime() > CLAIM_WINDOW_MS) {
          continue;
        }
        const normalizedBody = normalizeWhitespace(comment.body);
        const foundKeyword = keywords.find(keyword =>
          normalizedBody.includes(normalizeWhitespace(keyword)),
        );
        if (foundKeyword) {
          matchedClaim = {
            claimer: comment.author?.login ?? 'unknown',
            keyword: foundKeyword,
            createdAt: comment.createdAt,
          };
          break;
        }
      }

      const linkedPr = issueToOpenPr.get(node.number) ?? null;

      const info: ClaimInfo = {
        issueNumber: node.number,
        title: node.title,
        url: node.url,
        labels: node.labels,
        claimedBy: matchedClaim?.claimer ?? null,
        matchedKeyword: matchedClaim?.keyword ?? null,
        claimedAt: matchedClaim?.createdAt ?? null,
        linkedPrNumber: linkedPr?.number ?? null,
        linkedPrUrl: linkedPr?.url ?? null,
      };

      if (matchedClaim) {
        claimed.push(info);
      } else {
        unclaimed.push(info);
      }
    }

    return {repoPath, claimed, unclaimed};
  };

  /**
   * 입력된 저장소 목록이 GitHub에 실제로 존재하고 접근 가능한지 한 번의 GraphQL 쿼리로 검증합니다.
   * 존재하지 않거나 접근할 수 없는 저장소의 repoPath 목록을 반환합니다.
   * @param repos 검증할 저장소 목록 (owner, repoName, repoPath)
   * @returns 존재하지 않거나 접근 불가한 저장소 경로 목록
   */
  const validateRepositoriesExist = async (
    repos: {owner: string; repoName: string; repoPath: string}[],
  ): Promise<string[]> => {
    const varDefs = repos
      .map((_, i) => `$o${i}: String!, $n${i}: String!`)
      .join(', ');
    const fields = repos
      .map(
        (_, i) =>
          `r${i}: repository(owner: $o${i}, name: $n${i}) { nameWithOwner }`,
      )
      .join('\n');

    const query = `query(${varDefs}) {\n${fields}\n}`;

    const variables: Record<string, string> = {};
    repos.forEach((repo, i) => {
      variables[`o${i}`] = repo.owner;
      variables[`n${i}`] = repo.repoName;
    });

    type ExistenceData = Record<string, {nameWithOwner: string} | null>;

    let data: ExistenceData;
    try {
      data = await githubGraphQL<ExistenceData>(query, variables);
    } catch (error: unknown) {
      const partial = (error as {data?: ExistenceData}).data;
      if (!partial) throw error;
      data = partial;
    }

    return repos.filter((_, i) => !data[`r${i}`]).map(repo => repo.repoPath);
  };

  return {
    getDetailedRepoData,
    getRecentClaimsData,
    validateRepositoriesExist,
  };
};
