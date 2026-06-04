import {describe, expect, test} from 'bun:test';
import {buildUserScoresTxt, type ScoreOutputData} from '../src/output';

const analyzedAt = new Date(2026, 5, 4, 9, 30);

describe('TXT 리포트 출력', () => {
  test('reposcore-cs와 같은 제목, 분석 일시, Markdown 표 형식으로 출력해야 한다', () => {
    const data: ScoreOutputData = {
      repoSummaries: [
        {
          repoPath: 'oss2026hnu/reposcore-ts',
          mergedPrFeatureBug: 0,
          mergedPrDocs: 0,
          mergedPrTypo: 0,
          closedIssueFeatureBug: 0,
          closedIssueDocs: 0,
        },
      ],
      userScores: [
        {
          userId: 'alpha',
          totalScore: 16,
          repoScores: [
            {
              owner: 'oss2026hnu',
              repo: 'reposcore-ts',
              scoreData: [
                {
                  userId: 'alpha',
                  prFeatureBug: 2,
                  prDocs: 1,
                  prTypo: 1,
                  issueFeatureBug: 2,
                  issueDocs: 1,
                },
              ],
            },
          ],
        },
      ],
    };

    const result = buildUserScoresTxt(data, analyzedAt);

    expect(result).toContain(
      '=== oss2026hnu/reposcore-ts 오픈소스 기여도 분석 리포트 ===',
    );
    expect(result).toContain('분석 일시: 2026-06-04 09:30');
    expect(result).toContain(
      '| User  | Issues (Docs/Features) | PR (Docs/Features/Typo) | Score |',
    );
    expect(result).toContain(
      '| ----- | ---------------------: | ----------------------: | ----: |',
    );
    expect(result).toContain('alpha');
    expect(result).toContain('3 (1/2)');
    expect(result).toContain('4 (1/2/1)');
    expect(result).toContain('16 |');
    expect(result).not.toContain('[oss2026hnu/reposcore-ts]');
  });

  test('미인정 항목이 있으면 추가 제안 섹션을 출력해야 한다', () => {
    const data: ScoreOutputData = {
      repoSummaries: [
        {
          repoPath: 'oss2026hnu/reposcore-ts',
          mergedPrFeatureBug: 0,
          mergedPrDocs: 0,
          mergedPrTypo: 0,
          closedIssueFeatureBug: 0,
          closedIssueDocs: 0,
        },
      ],
      userScores: [
        {
          userId: 'beta',
          totalScore: 6,
          repoScores: [
            {
              owner: 'oss2026hnu',
              repo: 'reposcore-ts',
              scoreData: [
                {
                  userId: 'beta',
                  prFeatureBug: 0,
                  prDocs: 5,
                  prTypo: 0,
                  issueFeatureBug: 0,
                  issueDocs: 0,
                },
              ],
            },
          ],
        },
      ],
    };

    const result = buildUserScoresTxt(data, analyzedAt);

    expect(result).toContain('=== 미인정 항목 및 추가 제안 ===');
    expect(result).toContain('beta:');
    expect(result).toContain(
      '[미인정 항목] 문서/오타 PR 2개 초과(한도 3개) / 이슈 0개 초과(한도 12개)',
    );
    expect(result).toContain(
      '[추가 제안] 기능/버그 PR 1개 추가 시 문서PR 인정 한도 +3',
    );
  });
});
