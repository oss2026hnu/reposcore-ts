const CACHE_DIR = '.cache';

/** 기본 캐시 유효 시간: 24시간 (밀리초 단위) */
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// 저장소별 분석 캐시 데이터 구조. JSON 파일로 직렬화되어 저장됨.
export interface RepoCache<T> {
  repository: string;
  lastAnalyzedAt: string; // ISO 8601
  data: T;
}

// 캐시 파일 경로를 반환합니다.
const getCacheFilePath = (owner: string, repo: string): string =>
  `${CACHE_DIR}/${owner}_${repo}/cache.json`;

// 기존 캐시 파일을 읽어 RepoCache 객체를 반환합니다.
// 파일이 없거나 손상된 경우, noCache=true이거나 캐시가 만료된 경우 null을 반환합니다.
export const loadCache = async <T>(
  owner: string,
  repo: string,
  noCache = false,
): Promise<RepoCache<T> | null> => {
  if (noCache) {
    console.error('캐시를 무시하고 전체 데이터를 다시 수집합니다.');
    return null;
  }

  const cacheFile = getCacheFilePath(owner, repo);
  const file = Bun.file(cacheFile);

  if (!(await file.exists())) return null;

  try {
    const cache = (await file.json()) as RepoCache<T>;
    if (cache.repository !== `${owner}/${repo}`) return null;

    // lastAnalyzedAt 유효성 검사
    if (!cache.lastAnalyzedAt) {
      console.error(
        `[cache] ${owner}/${repo} — 캐시 저장 시각이 없어 새로 수집합니다.`,
      );
      return null;
    }

    const analyzedAt = Date.parse(cache.lastAnalyzedAt);

    if (Number.isNaN(analyzedAt)) {
      console.error(
        `[cache] ${owner}/${repo} — 캐시 저장 시각이 올바르지 않아 새로 수집합니다.`,
      );
      return null;
    }

    // TTL 초과 여부 검사
    if (Date.now() - analyzedAt > DEFAULT_CACHE_TTL_MS) {
      console.error(
        `[cache] ${owner}/${repo} — 캐시가 만료되어 새로 수집합니다.`,
      );
      return null;
    }

    console.error(`[cache] ${owner}/${repo} — 캐시에서 읽습니다.`);
    return cache;
  } catch {
    console.error('기존 캐시 파일이 손상되어 새로 수집을 시작합니다.');
    return null;
  }
};

// 분석 결과 캐시를 JSON 파일로 저장. 저장 시각을 함께 기록합니다.
export const saveCache = async <T>(
  owner: string,
  repo: string,
  data: T,
): Promise<void> => {
  const cache: RepoCache<T> = {
    repository: `${owner}/${repo}`,
    lastAnalyzedAt: new Date().toISOString(),
    data,
  };

  await Bun.write(
    getCacheFilePath(owner, repo),
    JSON.stringify(cache, null, 2),
  );
  console.error(`[cache] ${owner}/${repo} — 캐시를 저장했습니다.`);
};
