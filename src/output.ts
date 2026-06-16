import {mkdir} from 'node:fs/promises';
import {categorizeLabels, countByCategory} from './github-service';
import type {DetailedRepoData, RepoClaims} from './types';
import {ScoreCalculator, type UserScore} from './score-calculator'; // ScoreCalculator 클래스 임포트 추가

const DEFAULT_OUTPUT_DIR = 'output';
const CSV_FILENAME = 'scores.csv';
const TXT_FILENAME = 'scores.txt';
const HTML_FILENAME = 'scores.html';

export const supportedFormats = ['csv', 'txt', 'html'] as const;
export type SupportedFormat = (typeof supportedFormats)[number];

export interface RepoSummary {
  repoPath: string;
  mergedPrFeatureBug: number;
  mergedPrDocs: number;
  mergedPrTypo: number;
  closedIssueFeatureBug: number;
  closedIssueDocs: number;
}

export interface OutputPaths {
  csv: string;
  txt: string;
  html: string;
}

/**
 * 출력 디렉토리와 서브 디렉토리 정보를 조합하여 최종 파일 저장 경로 객체를 생성합니다.
 * 향후 --output 옵션이 추가되어도 경로 조합 로직이 한곳에 모이도록 분리합니다.
 *
 * @param outputDir 기본 출력 디렉토리 명 (기본값: 'output')
 * @param subDir 추가적으로 지정할 하위 디렉토리 명 (선택 사항)
 * @returns 생성된 CSV 및 TXT 파일의 경로 정보를 담은 OutputPaths 객체
 */
export const getOutputPaths = (
  outputDir: string = DEFAULT_OUTPUT_DIR,
  subDir?: string,
): OutputPaths => {
  const targetDir = subDir ? `${outputDir}/${subDir}` : outputDir;
  return {
    csv: `${targetDir}/${CSV_FILENAME}`,
    txt: `${targetDir}/${TXT_FILENAME}`,
    html: `${targetDir}/${HTML_FILENAME}`,
  };
};

/**
 * DetailedRepoData를 저장소별 기여 카테고리 요약 정보(RepoSummary)로 변환합니다.
 * TXT 파일에서 가독성 있는 저장소별 블록을 생성하는 데 사용됩니다.
 *
 * @param repoPath 대상 저장소의 경로 명 (예: 'owner/repo')
 * @param detailed 이슈와 PR 목록을 포함한 저장소 상세 데이터
 * @returns 카테고리별 기여 개수가 집계된 RepoSummary 객체
 */
export const summarizeRepo = (
  repoPath: string,
  detailed: DetailedRepoData,
): RepoSummary => {
  const prCounts = countByCategory(detailed.prs);
  const issueCounts = countByCategory(detailed.issues);
  return {
    repoPath,
    mergedPrFeatureBug: prCounts.feature + prCounts.bug,
    mergedPrDocs: prCounts.doc,
    mergedPrTypo: prCounts.typo,
    closedIssueFeatureBug: issueCounts.feature + issueCounts.bug,
    closedIssueDocs: issueCounts.doc,
  };
};

const USER_CSV_HEADERS = [
  'userId',
  'prFeatureBug',
  'prDocs',
  'prTypo',
  'issueFeatureBug',
  'issueDocs',
  'totalScore',
] as const;

interface UserContributionCounts {
  userId: string;
  prFeatureBug: number;
  prDocs: number;
  prTypo: number;
  issueFeatureBug: number;
  issueDocs: number;
  totalScore: number;
}

const aggregateUserContribution = (user: UserScore): UserContributionCounts => {
  const aggregated = ScoreCalculator.getAccumulatedContributions(user);

  return {
    userId: user.userId,
    prFeatureBug: aggregated.prFeatureBug,
    prDocs: aggregated.prDocs,
    prTypo: aggregated.prTypo,
    issueFeatureBug: aggregated.issueFeatureBug,
    issueDocs: aggregated.issueDocs,
    totalScore: user.totalScore,
  };
};

const formatDateTime = (date: Date): string => {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join(
      '-',
    ) + ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
};

const buildAsciiTable = (
  headers: readonly string[],
  rows: ReadonlyArray<readonly string[]>,
): string[] => {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map(row => row[index]?.length ?? 0)),
  );
  const formatRow = (cells: readonly string[]): string =>
    `| ${cells
      .map((cell, index) => cell.padEnd(widths[index]!))
      .join(' | ')} |`;
  const border = `+${widths.map(width => '-'.repeat(width + 2)).join('+')}+`;

  return [border, formatRow(headers), border, ...rows.map(formatRow), border];
};

/**
 * 전체 사용자 점수 목록을 받아 CSV 파일에 기록할 텍스트 문자열을 빌드합니다.
 *
 * @param userScores 각 사용자별 점수 및 상세 기여 데이터 배열
 * @returns CSV 형식으로 인코딩된 헤더와 데이터 문자열
 */
export const buildUserScoresCsv = (users: ReadonlyArray<UserScore>): string => {
  const rows = users.map(user => {
    const {
      userId,
      prFeatureBug,
      prDocs,
      prTypo,
      issueFeatureBug,
      issueDocs,
      totalScore,
    } = aggregateUserContribution(user);

    return [
      userId,
      prFeatureBug,
      prDocs,
      prTypo,
      issueFeatureBug,
      issueDocs,
      totalScore,
    ].join(',');
  });
  return [USER_CSV_HEADERS.join(','), ...rows].join('\n') + '\n';
};

/**
 * 저장소 요약 데이터 정보와 전체 사용자 점수 데이터를 가독성 있는 텍스트(TXT) 포맷 문자열로 빌드합니다.
 *
 * @param data 저장소 요약 및 사용자 점수 데이터 정보 객체
 * @param analyzedAt 리포트 분석 시각. Node.js/Bun 런타임에서 별도 import 없이 사용하는 내장 Date 객체입니다.
 * @returns 텍스트(TXT) 파일용 보고서 문자열
 */
export const buildUserScoresTxt = (
  data: ScoreOutputData,
  analyzedAt: Date = new Date(),
): string => {
  const repoLabel = data.repoSummaries
    .map(summary => summary.repoPath)
    .join(' + ');
  const rows = data.userScores.map(aggregateUserContribution);
  const lines = [
    `=== ${repoLabel} 오픈소스 기여도 분석 리포트 ===`,
    `분석 일시: ${formatDateTime(analyzedAt)}`,
    '',
  ];
  const tableRows: string[][] = [];
  const rejections: string[] = [];

  for (const row of rows) {
    const totalIssues = row.issueDocs + row.issueFeatureBug;
    const totalPrs = row.prDocs + row.prFeatureBug + row.prTypo;

    tableRows.push([
      row.userId,
      String(row.totalScore),
      `${totalIssues} (${row.issueDocs}/${row.issueFeatureBug})`,
      `${totalPrs} (${row.prDocs}/${row.prFeatureBug}/${row.prTypo})`,
    ]);

    const limits = ScoreCalculator.calculateLimits(row);
    const totalDocTypoPr = row.prDocs + row.prTypo;
    const rejectedPr = Math.max(0, totalDocTypoPr - limits.maxAdditionalPr);
    const rejectedIssue = Math.max(0, totalIssues - limits.maxIssueCount);

    if (rejectedPr > 0 || rejectedIssue > 0) {
      const userRejections = [
        `${row.userId}:`,
        `    [미인정 항목] 문서/오타 PR ${rejectedPr}개 초과(한도 ${limits.maxAdditionalPr}개) / 이슈 ${rejectedIssue}개 초과(한도 ${limits.maxIssueCount}개)`,
      ];

      if (rejectedPr > 0) {
        const docRatio = ScoreCalculator.MAX_DOCS_TYPO_PR_RATIO;
        const docSuggestionCount = Math.ceil(rejectedPr / docRatio);
        userRejections.push(
          `    [추가 제안] 기능/버그 PR ${docSuggestionCount}개 추가 시 문서PR 인정 한도 +${docSuggestionCount * docRatio}`,
        );
      }

      if (rejectedIssue > 0) {
        const issueRatio = ScoreCalculator.MAX_ISSUE_RATIO;
        const issueSuggestionCount = Math.ceil(rejectedIssue / issueRatio);
        if (totalDocTypoPr < limits.maxAdditionalPr) {
          userRejections.push(
            `    [추가 제안] 문서 PR ${issueSuggestionCount}개 추가 혹은 기능/버그 PR ${issueSuggestionCount}개 추가시 이슈 인정한도 +${issueSuggestionCount * issueRatio}`,
          );
        } else {
          userRejections.push(
            `    [추가 제안] 기능/버그 PR ${issueSuggestionCount}개 추가시 이슈 인정한도 +${issueSuggestionCount * issueRatio}`,
          );
        }
      }

      rejections.push(userRejections.join('\n'));
    }
  }

  lines.push(
    ...buildAsciiTable(
      ['User', 'Score', 'Issues (Doc/Feat)', 'PR (Doc/Feat/Typo)'],
      tableRows,
    ),
  );

  if (rejections.length > 0) {
    lines.push('', '=== 미인정 항목 및 추가 제안 ===', '', ...rejections);
  }

  return lines.join('\n') + '\n';
};

export interface ScoreOutputData {
  userScores: ReadonlyArray<UserScore>;
  repoSummaries: ReadonlyArray<RepoSummary>;
}

/**
 * 사용자별 기여 항목을 보여주는 누적 막대 차트를 포함한 HTML 보고서를 빌드합니다.
 * Chart.js(가로 누적 막대)와 datalabels 플러그인을 CDN으로 로드합니다.
 *
 * @param data 저장소 요약 및 사용자 점수 데이터 정보 객체
 * @returns HTML 파일용 보고서 문자열
 */
export const buildHtmlReport = (data: ScoreOutputData): string => {
  const users = data.userScores.map(user => {
    const agg = ScoreCalculator.getAccumulatedContributions(user);
    return {
      label: `${user.userId} (점수: ${user.totalScore})`,
      issueDocs: agg.issueDocs,
      issueFeatureBug: agg.issueFeatureBug,
      prTypo: agg.prTypo,
      prDocs: agg.prDocs,
      prFeatureBug: agg.prFeatureBug,
    };
  });

  const labels = JSON.stringify(users.map(u => u.label));
  const issueDocs = JSON.stringify(users.map(u => u.issueDocs));
  const issueFeatureBug = JSON.stringify(users.map(u => u.issueFeatureBug));
  const prTypo = JSON.stringify(users.map(u => u.prTypo));
  const prDocs = JSON.stringify(users.map(u => u.prDocs));
  const prFeatureBug = JSON.stringify(users.map(u => u.prFeatureBug));
  const chartHeight = Math.max(400, users.length * 30);

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RepoScore Report</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.9/dist/chart.umd.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-datalabels@2.2.0/dist/chartjs-plugin-datalabels.min.js"></script>
  <style>
    body { font-family: sans-serif; padding: 20px; }
    h1 { border-bottom: 2px solid #eee; padding-bottom: 10px; }
  </style>
</head>
<body>
  <h1>RepoScore Report</h1>
  <canvas id="chart" style="height:${chartHeight}px;"></canvas>
  <script>
    Chart.register(ChartDataLabels);
    new Chart(document.getElementById('chart'), {
      type: 'bar',
      data: {
        labels: ${labels},
        datasets: [
          {
            label: '문서 이슈',
            data: ${issueDocs},
            backgroundColor: 'rgba(54,162,235,0.8)'
          },
          {
            label: '기능·버그 이슈',
            data: ${issueFeatureBug},
            backgroundColor: 'rgba(255,99,132,0.8)'
          },
          {
            label: '오타 PR',
            data: ${prTypo},
            backgroundColor: 'rgba(255,206,86,0.8)'
          },
          {
            label: '문서 PR',
            data: ${prDocs},
            backgroundColor: 'rgba(75,192,192,0.8)'
          },
          {
            label: '기능·버그 PR',
            data: ${prFeatureBug},
            backgroundColor: 'rgba(153,102,255,0.8)'
          }
        ]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        plugins: {
          legend: { position: 'top' },
          title: {
            display: true,
            text: 'RepoScore - 사용자별 기여 현황'
          },
          datalabels: {
            display: context => context.dataset.data[context.dataIndex] > 0,
            color: '#fff',
            font: { weight: 'bold' },
            formatter: value => value
          }
        },
        scales: {
          x: { stacked: true },
          y: { stacked: true }
        }
      }
    });
  </script>
</body>
</html>`;
};

/**
 * 최종 결과 데이터를 기반으로 파일 시스템에 출력 파일을 작성합니다.
 * CSV는 항상 생성하며, formats에 'txt' 또는 'html'이 포함된 경우
 * 해당 파일도 함께 생성합니다.
 * reposcore-cs와 동일한 사양을 따릅니다.
 *
 * @param formats 생성할 파일의 포맷 형식 목록 ('csv', 'txt', 'html')
 * @param data 최종 출력할 저장소 요약 및 사용자 점수 데이터 정보 객체
 * @param outputDir 파일이 저장될 기본 출력 디렉토리 경로 (기본값: DEFAULT_OUTPUT_DIR)
 * @param subDir 추가적으로 생성할 하위 디렉토리 명 (선택 사항)
 * @returns 작성이 완료된 파일들의 경로 정보를 담은 Promise 객체
 */
export const writeOutputFiles = async (
  formats: ReadonlyArray<SupportedFormat>,
  data: ScoreOutputData,
  outputDir: string = DEFAULT_OUTPUT_DIR,
  subDir?: string,
): Promise<{csv: string; txt?: string; html?: string}> => {
  const paths = getOutputPaths(outputDir, subDir);

  const targetDir = subDir ? `${outputDir}/${subDir}` : outputDir;
  await mkdir(targetDir, {recursive: true});

  await Bun.write(paths.csv, buildUserScoresCsv(data.userScores));

  const written: {csv: string; txt?: string; html?: string} = {
    csv: paths.csv,
  };

  if (formats.includes('txt')) {
    const userScoresTxt = buildUserScoresTxt(data);
    await Bun.write(paths.txt, userScoresTxt);
    written.txt = paths.txt;
  }

  if (formats.includes('html')) {
    const htmlReport = buildHtmlReport(data);
    await Bun.write(paths.html, htmlReport);
    written.html = paths.html;
  }

  return written;
};

/**
 * 이슈 라벨을 기반으로 작업 유형 및 기한(시간)을 결정합니다.
 * documentation/typo 계열 라벨은 문서 작업(24h), 그 외는 코드 작업(48h)으로 처리합니다.
 */
const getTaskDeadline = (labels: {
  nodes: {name: string}[];
}): {type: string; hours: number} => {
  const labelNames = labels.nodes.map(node => node.name);
  const category = categorizeLabels(labelNames);
  const isDoc = category === 'doc' || category === 'typo';

  return isDoc ? {type: '문서', hours: 24} : {type: '코드', hours: 48};
};

/**
 * 기한 대비 남은 시간 또는 초과 여부를 계산하여 상태 문자열을 반환합니다.
 */
const getDeadlineStatus = (
  claimedAt: string,
  deadlineHours: number,
  linkedPrNumber: number | null,
  linkedPrUrl: string | null,
): string => {
  if (linkedPrNumber !== null) {
    return `PR 생성됨 - #${linkedPrNumber} (${linkedPrUrl})`;
  }

  const start = new Date(claimedAt).getTime();
  const now = new Date().getTime();
  const deadline = start + deadlineHours * 60 * 60 * 1000;
  const remaining = deadline - now;

  if (remaining <= 0) {
    const overdueHours = Math.floor(Math.abs(remaining) / (1000 * 60 * 60));
    return `기한 초과 (${overdueHours}시간 경과 - 재선점 가능)`;
  }

  const h = Math.floor(remaining / (1000 * 60 * 60));
  const m = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
  return `남은 시간: ${h}시간 ${m}분`;
};

/**
 * 선점 현황 데이터를 표준 출력(stdout)에 사람이 읽기 좋은 형태로 출력합니다.
 *
 * @param claims 저장소별 선점 및 미선점 이슈 정보
 * @param mode 출력 모드 ('issue' 또는 'user')
 */
export const printClaims = (
  claims: RepoClaims,
  mode: 'issue' | 'user' = 'issue',
): void => {
  console.log(`\n[${claims.repoPath}]`);

  // 1. 원본 배열을 변경하지 않도록 복사([...]) 후 issueNumber 오름차순 정렬
  const sortedClaimed = [...claims.claimed].sort(
    (a, b) => a.issueNumber - b.issueNumber,
  );

  const sortedUnclaimed = [...claims.unclaimed].sort(
    (a, b) => a.issueNumber - b.issueNumber,
  );

  console.log(mode === 'user' ? '선점된 이슈 (사용자별)' : '선점된 이슈');
  if (sortedClaimed.length === 0) {
    console.log('  (없음)');
  } else {
    if (mode === 'user') {
      const byUser = new Map<string, typeof sortedClaimed>();
      for (const c of sortedClaimed) {
        const user = c.claimedBy || 'unknown';
        if (!byUser.has(user)) {
          byUser.set(user, []);
        }
        byUser.get(user)!.push(c);
      }

      const sortedUsers = Array.from(byUser.keys()).sort();

      for (const user of sortedUsers) {
        console.log(`\n[${user}]`);
        for (const c of byUser.get(user)!) {
          console.log(`- #${c.issueNumber} ${c.title}`);
          console.log(`  URL: ${c.url}`);
          if (c.claimedAt) {
            const {type, hours} = getTaskDeadline(c.labels);
            const status = getDeadlineStatus(
              c.claimedAt,
              hours,
              c.linkedPrNumber,
              c.linkedPrUrl,
            );
            console.log(`  상태: ${type} [${hours}시간 기한] | ${status}`);
          }
        }
      }
    } else {
      for (const c of sortedClaimed) {
        console.log(`- #${c.issueNumber} ${c.title}`);
        console.log(`  URL: ${c.url}`);
        if (c.claimedAt) {
          const {type, hours} = getTaskDeadline(c.labels);
          const status = getDeadlineStatus(
            c.claimedAt,
            hours,
            c.linkedPrNumber,
            c.linkedPrUrl,
          );
          console.log(`  선점자: ${c.claimedBy}`);
          console.log(`  상태: ${type} [${hours}시간 기한] | ${status}`);
        } else {
          console.log(`  선점자: ${c.claimedBy}`);
        }
      }
    }
  }

  console.log('\n미선점 이슈');
  if (sortedUnclaimed.length === 0) {
    console.log('  (없음)');
  } else {
    // 3. 기존 claims.unclaimed 대신 정렬된 sortedUnclaimed 배열을 순회하도록 변경
    for (const u of sortedUnclaimed) {
      console.log(`- #${u.issueNumber} ${u.title}`);
      console.log(`  URL: ${u.url}`);
    }
  }
};
