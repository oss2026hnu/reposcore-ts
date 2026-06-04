import {mkdir} from 'node:fs/promises';
import {countByCategory} from './github-service';
import type {DetailedRepoData} from './types';
import type {UserScore} from './score-calculator';

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
  let prFeatureBug = 0;
  let prDocs = 0;
  let prTypo = 0;
  let issueFeatureBug = 0;
  let issueDocs = 0;

  for (const repo of user.repoScores) {
    for (const data of repo.scoreData) {
      prFeatureBug += data.prFeatureBug;
      prDocs += data.prDocs;
      prTypo += data.prTypo;
      issueFeatureBug += data.issueFeatureBug;
      issueDocs += data.issueDocs;
    }
  }

  return {
    userId: user.userId,
    prFeatureBug,
    prDocs,
    prTypo,
    issueFeatureBug,
    issueDocs,
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

const buildMarkdownTable = (
  headers: readonly string[],
  rows: ReadonlyArray<readonly string[]>,
  rightAlignedColumns: ReadonlySet<number>,
): string[] => {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map(row => row[index]?.length ?? 0)),
  );
  const formatRow = (cells: readonly string[]): string =>
    `| ${cells
      .map((cell, index) =>
        rightAlignedColumns.has(index)
          ? cell.padStart(widths[index]!)
          : cell.padEnd(widths[index]!),
      )
      .join(' | ')} |`;
  const separator = `| ${widths
    .map((width, index) =>
      rightAlignedColumns.has(index)
        ? `${'-'.repeat(Math.max(width - 1, 1))}:`
        : '-'.repeat(width),
    )
    .join(' | ')} |`;

  return [formatRow(headers), separator, ...rows.map(formatRow)];
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
 * @param analyzedAt 리포트 분석 시각
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
      `${totalIssues} (${row.issueDocs}/${row.issueFeatureBug})`,
      `${totalPrs} (${row.prDocs}/${row.prFeatureBug}/${row.prTypo})`,
      String(row.totalScore),
    ]);

    const maxAdditionalPr = 3 * Math.max(row.prFeatureBug, 1);
    const totalDocTypoPr = row.prDocs + row.prTypo;
    const rejectedPr = Math.max(0, totalDocTypoPr - maxAdditionalPr);
    const validPrCount =
      row.prFeatureBug + Math.min(totalDocTypoPr, maxAdditionalPr);
    const maxIssueCount = 4 * validPrCount;
    const rejectedIssue = Math.max(0, totalIssues - maxIssueCount);

    if (rejectedPr > 0 || rejectedIssue > 0) {
      const userRejections = [
        `${row.userId}:`,
        `   [미인정 항목] 문서/오타 PR ${rejectedPr}개 초과(한도 ${maxAdditionalPr}개) / 이슈 ${rejectedIssue}개 초과(한도 ${maxIssueCount}개)`,
      ];

      if (rejectedPr > 0) {
        const docSuggestionCount = Math.ceil(rejectedPr / 3);
        userRejections.push(
          `   [추가 제안] 기능/버그 PR ${docSuggestionCount}개 추가 시 문서PR 인정 한도 +${docSuggestionCount * 3}`,
        );
      }

      if (rejectedIssue > 0) {
        const issueSuggestionCount = Math.ceil(rejectedIssue / 4);
        if (totalDocTypoPr < maxAdditionalPr) {
          userRejections.push(
            `   [추가 제안] 문서 PR ${issueSuggestionCount}개 추가 혹은 기능/버그 PR ${issueSuggestionCount}개 추가시 이슈 인정한도 +${issueSuggestionCount * 4}`,
          );
        } else {
          userRejections.push(
            `   [추가 제안] 기능/버그 PR ${issueSuggestionCount}개 추가시 이슈 인정한도 +${issueSuggestionCount * 4}`,
          );
        }
      }

      rejections.push(userRejections.join('\n'));
    }
  }

  lines.push(
    ...buildMarkdownTable(
      ['User', 'Issues (Docs/Features)', 'PR (Docs/Features/Typo)', 'Score'],
      tableRows,
      new Set([1, 2, 3]),
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
 * 저장소 요약 데이터 정보와 전체 사용자 점수 데이터를 가독성 있는 HTML 포맷 문자열로 빌드합니다.
 *
 * @param data 저장소 요약 및 사용자 점수 데이터 정보 객체
 * @returns HTML 파일용 보고서 문자열
 */
export const buildHtmlReport = (data: ScoreOutputData): string => {
  const repoRows = data.repoSummaries
    .map(
      s => `
    <tr>
      <td>${s.repoPath}</td>
      <td>${s.mergedPrFeatureBug}</td>
      <td>${s.mergedPrDocs}</td>
      <td>${s.mergedPrTypo}</td>
      <td>${s.closedIssueFeatureBug}</td>
      <td>${s.closedIssueDocs}</td>
    </tr>
  `,
    )
    .join('');

  const userRows = data.userScores
    .map(user => {
      let prFeatureBug = 0;
      let prDocs = 0;
      let prTypo = 0;
      let issueFeatureBug = 0;
      let issueDocs = 0;
      for (const repo of user.repoScores) {
        for (const scoreData of repo.scoreData) {
          prFeatureBug += scoreData.prFeatureBug;
          prDocs += scoreData.prDocs;
          prTypo += scoreData.prTypo;
          issueFeatureBug += scoreData.issueFeatureBug;
          issueDocs += scoreData.issueDocs;
        }
      }
      return `
    <tr>
      <td>${user.userId}</td>
      <td>${prFeatureBug}</td>
      <td>${prDocs}</td>
      <td>${prTypo}</td>
      <td>${issueFeatureBug}</td>
      <td>${issueDocs}</td>
      <td><strong>${user.totalScore}</strong></td>
    </tr>
    `;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RepoScore Report</title>
  <style>
    body { font-family: sans-serif; padding: 20px; }
    table { border-collapse: collapse; width: 100%; margin-bottom: 30px; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: right; }
    th { background-color: #f2f2f2; text-align: center; }
    td:first-child { text-align: left; font-weight: bold; }
    h2 { border-bottom: 2px solid #eee; padding-bottom: 10px; }
  </style>
</head>
<body>
  <h1>RepoScore Report</h1>

  <h2>Repository Summaries</h2>
  <table>
    <thead>
      <tr>
        <th>Repository</th>
        <th>Merged PRs (Feature/Bug)</th>
        <th>Merged PRs (Docs)</th>
        <th>Merged PRs (Typo)</th>
        <th>Closed Issues (Feature/Bug)</th>
        <th>Closed Issues (Docs)</th>
      </tr>
    </thead>
    <tbody>
      ${repoRows}
    </tbody>
  </table>

  <h2>User Scores</h2>
  <table>
    <thead>
      <tr>
        <th>User ID</th>
        <th>PR (Feature/Bug)</th>
        <th>PR (Docs)</th>
        <th>PR (Typo)</th>
        <th>Issue (Feature/Bug)</th>
        <th>Issue (Docs)</th>
        <th>Total Score</th>
      </tr>
    </thead>
    <tbody>
      ${userRows}
    </tbody>
  </table>
</body>
</html>`;
};

/**
 * 최종 결과 데이터를 기반으로 파일 시스템에 출력 파일을 작성합니다.
 * CSV는 항상 생성하며, format 인자가 'txt'인 경우 TXT 파일도 함께 생성합니다.
 * reposcore-cs와 동일한 사양을 따릅니다.
 *
 * @param format 생성할 파일의 포맷 형식 ('csv', 'txt', 'html')
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
