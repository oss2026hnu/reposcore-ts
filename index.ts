import {cac} from 'cac';
import pkg from './package.json' with {type: 'json'};

import {createGitHubService, formatGitHubApiError} from './src/github-service';
import {ScoreCalculator, type RepoData} from './src/score-calculator';
import {
  summarizeRepo,
  writeOutputFiles,
  supportedFormats,
  type SupportedFormat,
  type RepoSummary,
  printClaims,
} from './src/output';
import {
  sortUserScores,
  supportedSortBys,
  supportedSortOrders,
  type SupportedSortBy,
  type SupportedSortOrder,
} from './src/sort';
import {type FullGitHubService} from './src/types';
import {setVerbose, logVerbose} from './src/logger';
import {
  findDuplicateParsedRepos,
  parseRepoPath,
  type ParsedRepo,
} from './src/repo-input';

// --keywords 옵션 설명 문자열과 실제 폴백 값이 항상 일치하도록 단일 위치에서 정의합니다.
const DEFAULT_KEYWORDS = [
  '제가 하겠습니다',
  '진행하겠습니다',
  '할게요',
  "I'll take this",
];

const cli = cac('reposcore-ts');
cli.version(pkg.version);

cli
  .command('[...repos]', '대상 저장소 목록 (예: owner/repo1 owner/repo2)')
  .option('-t, --token <token>', 'GitHub Personal Access Token', {
    default: '$GITHUB_TOKEN',
  })
  .option('-f, --format <format>', '출력 형식 (csv, txt, html)', {
    default: 'csv',
  })
  .option('--output-dir <path>', '결과 파일을 저장할 디렉터리', {
    default: 'output',
  })
  .option('--no-cache', '캐시를 무시하고 GitHub API를 새로 호출합니다')
  .option('--since <since>', '캐시 이후 증분 수집 기준 시점 ISO8601')
  .option('--sort-by <field>', '정렬 기준 (score, id)', {
    default: 'score',
  })
  .option('--sort-order <order>', '정렬 방식 (asc, desc)', {
    default: 'desc',
  })
  .option('--claims [issue|user]', '최근 이슈 선점 현황 조회 (기본 issue)')
  .option(
    '--keywords [items]',
    `이슈 선점 키워드 목록(쉼표 구분, 기본값: ${DEFAULT_KEYWORDS.join(',')})`,
    {
      type: [String],
    },
  )
  .option('--page-size <number>', '한 번에 가져올 항목 수 (1~100)', {
    default: '$PAGE_SIZE',
  })
  .option('--verbose', '진단 및 진행 로그를 출력합니다')
  .action(
    async (
      repos: string[],
      options: {
        token?: string;
        format: string;
        cache: boolean;
        outputDir?: string;
        since?: string;
        sortBy: string;
        sortOrder: string;
        claims?: boolean | string;
        keywords?: string | string[];
        pageSize?: number | string;
        verbose?: boolean;
      },
    ) => {
      setVerbose(!!options.verbose);

      // CLI 옵션값을 내부에서 사용할 형태로 정규화합니다.
      const token =
        options.token === '$GITHUB_TOKEN'
          ? Bun.env.GITHUB_TOKEN || ''
          : options.token || '';
      const formats = String(options.format || 'csv')
        .toLowerCase()
        .split(',')
        .map(format => format.trim())
        .filter(Boolean);
      const useCache = options.cache;
      const outputDir = options.outputDir || 'output';
      const since = options.since;
      const sortBy = String(options.sortBy || 'score').toLowerCase();
      const sortOrder = String(options.sortOrder || 'desc').toLowerCase();

      const rawPageSize =
        options.pageSize === '$PAGE_SIZE'
          ? (Bun.env.PAGE_SIZE ?? 100)
          : options.pageSize;
      const pageSize = Number(rawPageSize);

      const errors: string[] = [];

      const isClaimsMode = options.claims !== undefined;
      const claimsMode =
        typeof options.claims === 'string'
          ? options.claims.toLowerCase()
          : 'issue';

      // cac는 값 없이 --keywords만 입력하면 ['true']를 넘깁니다.
      // undefined(옵션 미지정)와 ['true'](값 없는 --keywords) 모두 기본 키워드로 폴백합니다.
      const isDefaultFallback =
        options.keywords === undefined ||
        String(options.keywords) === 'undefined' ||
        (Array.isArray(options.keywords) &&
          options.keywords.length === 1 &&
          options.keywords[0] === 'true');

      const rawKeywords = isDefaultFallback
        ? DEFAULT_KEYWORDS.join(',')
        : Array.isArray(options.keywords)
          ? options.keywords.join(',')
          : String(options.keywords);

      const claimKeywords = rawKeywords
        .split(',')
        .map(k => k.trim())
        .filter(Boolean);

      if (isClaimsMode && claimKeywords.length === 0) {
        errors.push(
          '오류: --keywords에는 하나 이상의 선점 키워드를 입력해야 합니다.',
        );
      }

      if (isClaimsMode && claimsMode !== 'issue' && claimsMode !== 'user') {
        errors.push(
          `오류: 지원하지 않는 --claims 모드 '${options.claims}'입니다. issue 또는 user를 입력하세요.`,
        );
      }

      const parsedRepos: ParsedRepo[] = [];

      // CLI 실행에 필요한 옵션과 입력값을 검증합니다.
      if (!token) {
        errors.push(
          '오류: GitHub 토큰이 필요합니다. --token 옵션 또는 GITHUB_TOKEN 환경 변수를 설정하세요.',
        );
      }

      if (formats.length === 0) {
        errors.push(
          '오류: --format에는 csv, txt, html 중 하나 이상의 출력 형식을 입력하세요.',
        );
      }

      const invalidFormats = formats.filter(
        format => !supportedFormats.includes(format as SupportedFormat),
      );

      if (invalidFormats.length > 0) {
        errors.push(
          `오류: 지원하지 않는 출력 형식 '${invalidFormats.join(', ')}'입니다. csv, txt 또는 html을 입력하세요.`,
        );
      }

      if (!supportedSortBys.includes(sortBy as SupportedSortBy)) {
        errors.push(
          `오류: 지원하지 않는 정렬 기준 '${options.sortBy}'입니다. score 또는 id를 입력하세요.`,
        );
      }

      if (!supportedSortOrders.includes(sortOrder as SupportedSortOrder)) {
        errors.push(
          `오류: 지원하지 않는 정렬 방식 '${options.sortOrder}'입니다. asc 또는 desc를 입력하세요.`,
        );
      }

      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
        errors.push(
          `오류: --page-size 값은 1 이상 100 이하의 정수여야 합니다. (입력값: ${rawPageSize})`,
        );
      }

      if (repos.length === 0) {
        errors.push(
          '오류: 최소 하나 이상의 저장소(owner/repo)를 입력해야 합니다.',
        );
      }

      // 입력받은 저장소 경로를 owner/repo 형식으로 파싱합니다.
      for (const repoPath of repos) {
        const parsedRepo = parseRepoPath(repoPath);

        if (!parsedRepo) {
          errors.push(`오류: '${repoPath}'는 'owner/repo' 형식이 아닙니다.`);
          continue;
        }

        parsedRepos.push({
          repoPath,
          owner: parsedRepo.owner,
          repoName: parsedRepo.repoName,
        });
      }

      const duplicateRepos = findDuplicateParsedRepos(parsedRepos);
      for (const repo of duplicateRepos) {
        errors.push(
          `오류: 중복 저장소 '${repo.repoPath}'가 입력되었습니다. 같은 저장소는 한 번만 입력하세요.`,
        );
      }

      // 검증 중 발견된 오류를 출력하고 실행을 중단합니다.
      if (errors.length > 0) {
        for (const error of errors) {
          console.error(error);
        }

        cli.outputHelp();
        process.exit(1);
      }

      const githubService = createGitHubService(
        token,
        pageSize,
      ) as FullGitHubService;

      // 실제 데이터 수집 전에 모든 저장소가 GitHub에 존재하는지 한 번에 검증합니다.
      let missingRepos: string[];
      try {
        missingRepos =
          await githubService.validateRepositoriesExist(parsedRepos);
      } catch (error) {
        console.error(formatGitHubApiError(error));
        process.exit(1);
      }
      if (missingRepos.length > 0) {
        for (const repoPath of missingRepos) {
          console.error(
            `오류: 저장소 '${repoPath}'를 찾을 수 없거나 접근할 수 없습니다.`,
          );
        }
        process.exit(1);
      }

      // ── [개선] --claims 모드 병렬 처리 ──────────────────────────────────

      // --claims 옵션이 있으면 점수 계산 대신 이슈 선점 현황만 조회합니다.
      if (isClaimsMode) {
        // 조회 실패 여부를 추적하는 플래그입니다.
        // 루프 도중에 즉시 종료하지 않고 모든 저장소를 끝까지 처리한 뒤,
        // 루프가 완전히 끝난 후 이 플래그를 확인하여 종료 코드를 결정합니다.
        let hasClaimFailure = false;

        for (const {repoPath, owner, repoName} of parsedRepos) {
          try {
            const claims = await githubService.getRecentClaimsData(
              owner,
              repoName,
              claimKeywords,
              repoPath,
              useCache,
            );
            printClaims(claims, claimsMode as 'issue' | 'user');
          } catch (err) {
            hasClaimFailure = true;
            const msg = err instanceof Error ? err.message : String(err);
            console.error(
              `오류: '${repoPath}'의 선점 현황을 조회할 수 없습니다. (${msg})`,
            );
          }
        }

        if (hasClaimFailure) {
          process.exit(1);
        }
        return;
      }

      logVerbose(`형식: ${formats.join(', ')}`);
      logVerbose(`저장소: ${repos.join(', ')}`);

      // ── [개선] 일반 기여도 점수 산정 모드 병렬 처리 (Promise.allSettled) ──────
      const tasks = parsedRepos.map(async ({repoPath, owner, repoName}) => {
        const detailed = await githubService.getDetailedRepoData(
          owner,
          repoName,
          useCache,
          {since},
        );

        const repoData = ScoreCalculator.calculateRepoData(
          detailed,
          owner,
          repoName,
        );
        const repoSummary = summarizeRepo(repoPath, detailed);

        const singleUserScores = sortUserScores(
          ScoreCalculator.calculateUserScores([repoData]),
          sortBy as SupportedSortBy,
          sortOrder as SupportedSortOrder,
        );

        const subDir = `${owner}-${repoName}`;
        const written = await writeOutputFiles(
          formats as SupportedFormat[],
          {userScores: singleUserScores, repoSummaries: [repoSummary]},
          outputDir,
          subDir,
        );

        return {repoData, repoSummary, written};
      });

      const results = await Promise.allSettled(tasks);

      const repoDataList: RepoData[] = [];
      const repoSummaries: RepoSummary[] = [];
      let hasFailure = false;

      // 입력된 순서를 완벽하게 보장하며 순회 및 안전 분기 결합
      results.forEach((result, i) => {
        const {repoPath} = parsedRepos[i]!;

        if (result.status === 'fulfilled') {
          const {repoData, repoSummary, written} = result.value;
          repoDataList.push(repoData);
          repoSummaries.push(repoSummary);

          logVerbose(`[${repoPath}] CSV 저장: ${written.csv}`);
          if (written.txt) logVerbose(`[${repoPath}] TXT 저장: ${written.txt}`);
          if (written.html)
            logVerbose(`[${repoPath}] HTML 저장: ${written.html}`);
        } else {
          hasFailure = true;
          const reason =
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason);
          console.error(`오류: '${repoPath}'의 데이터를 가져올 수 없습니다.`);
          console.error(`상세 원인: ${reason}`);
        }
      });

      // 단 하나의 저장소라도 통신에 실패했다면 수집 작업 안내 후 종료 코드로 즉시 반영
      if (hasFailure) {
        process.exit(1);
      }

      // 모든 저장소 데이터를 합산하여 최종 사용자 점수를 계산합니다. (입력 순서가 보장된 리스트 활용)
      const userScores = sortUserScores(
        ScoreCalculator.calculateUserScores(repoDataList),
        sortBy as SupportedSortBy,
        sortOrder as SupportedSortOrder,
      );

      // 합산된 사용자 점수와 저장소 요약 정보를 파일로 출력합니다.
      const written = await writeOutputFiles(
        formats as SupportedFormat[],
        {
          userScores,
          repoSummaries,
        },
        outputDir,
      );
      console.error(`[합산] CSV 저장: ${written.csv}`);
      if (written.txt) {
        console.error(`[합산] TXT 저장: ${written.txt}`);
      }
      if (written.html) {
        console.error(`[합산] HTML 저장: ${written.html}`);
      }
    },
  );

cli.help();
cli.parse();
