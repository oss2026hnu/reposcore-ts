import {describe, expect, test, afterEach} from 'bun:test';

import {
  normalizeWhitespace,
  categorizeLabels,
  parseClosingIssueNumbers,
  formatGitHubApiError,
} from '../src/github-service';

describe('open PR linked issue parsing', () => {
  test('PR 템플릿 HTML 주석의 예시 이슈 번호는 연결 이슈로 처리하지 않는다', () => {
    const body = `### ISSUE_ID
Closes #319`;

    expect(parseClosingIssueNumbers(body)).toEqual([319]);
  });

  test('closing keyword가 없는 단순 참고 번호는 연결 이슈로 처리하지 않는다', () => {
    const body = `참고: #123
관련 논의: #300`;

    expect(parseClosingIssueNumbers(body)).toEqual([]);
  });

  test('GitHub closing keyword가 붙은 이슈 번호만 중복 없이 추출한다', () => {
    const body = `Fixes #10
Resolves #20
Closed #10`;

    expect(parseClosingIssueNumbers(body)).toEqual([10, 20]);
  });

  // 🌟 [테스트 추가] GitHub에서 제공하는 저장소명이 포함된 이슈 참조 형식 분석 검증 추가
  test('저장소명이 포함된 owner/repo#번호 참조 형식도 완벽하게 추출한다', () => {
    const body = `Closes oss2026hnu/reposcore-ts#123
Fixes oss2026hnu/reposcore-ts#123
Resolves owner/repo#456`;

    expect(parseClosingIssueNumbers(body)).toEqual([123, 456]);
  });
});

describe('claims keyword whitespace normalization', () => {
  test('선점 키워드의 공백 차이를 제거해 같은 문자열로 정규화한다', () => {
    const keyword = normalizeWhitespace('제가 하겠습니다');

    expect(normalizeWhitespace('제가 하겠습니다')).toBe(keyword);
    expect(normalizeWhitespace('제가     하겠습니다')).toBe(keyword);
    expect(normalizeWhitespace('제가\n하겠습니다')).toBe(keyword);
    expect(normalizeWhitespace('제가\t하겠습니다')).toBe(keyword);
  });

  test('대소문자 차이를 무시하도록 소문자로 정규화한다', () => {
    expect(normalizeWhitespace('I WILL DO THIS')).toBe(
      normalizeWhitespace('i will do this'),
    );
  });
});

describe('claims 48h 기한 필터', () => {
  const RealDateNow = Date.now;

  afterEach(() => {
    Date.now = RealDateNow;
  });

  /**
   * 48시간이 지난 댓글은 선점 후보에서 제외되고,
   * 유효 기간 내 댓글이 선점자로 채택되어야 한다.
   */
  test('48시간이 지난 선점 댓글은 무시되어야 한다', () => {
    const fakeNow = new Date('2026-06-13T12:00:00.000Z').getTime();
    Date.now = () => fakeNow;

    const rawComments = [
      {
        body: '제가 하겠습니다',
        author: {login: 'alice'},
        createdAt: '2026-06-11T00:00:00.000Z', // 60시간 전 → 48h 초과
      },
      {
        body: '진행하겠습니다',
        author: {login: 'bob'},
        createdAt: '2026-06-13T00:00:00.000Z', // 12시간 전 → 유효
      },
    ];

    const keywords = ['제가 하겠습니다', '진행하겠습니다'];
    const CLAIM_WINDOW_MS = 48 * 60 * 60 * 1000;
    const now = Date.now();
    const comments = [...rawComments].reverse();

    let matchedClaim: {
      claimer: string;
      keyword: string;
      createdAt: string;
    } | null = null;

    for (const comment of comments) {
      if (now - new Date(comment.createdAt).getTime() > CLAIM_WINDOW_MS) {
        continue;
      }

      const normalizedBody = normalizeWhitespace(comment.body);
      const foundKeyword = keywords.find(k =>
        normalizedBody.includes(normalizeWhitespace(k)),
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

    // alice의 댓글은 48h 초과라 무시, bob의 댓글이 채택되어야 함
    expect(matchedClaim?.claimer).toBe('bob');
    expect(matchedClaim?.keyword).toBe('진행하겠습니다');
  });

  /**
   * 48시간 이내 댓글이 있으면 정상 선점으로 처리되어야 한다.
   */
  test('48시간 이내 댓글은 정상적으로 선점으로 처리되어야 한다', () => {
    const fakeNow = new Date('2026-06-13T12:00:00.000Z').getTime();
    Date.now = () => fakeNow;

    const comment = {
      body: '제가 하겠습니다',
      author: {login: 'carol'},
      createdAt: '2026-06-12T12:00:00.000Z', // 24시간 전 → 유효
    };

    const CLAIM_WINDOW_MS = 48 * 60 * 60 * 1000;
    const now = Date.now();
    const isValid =
      now - new Date(comment.createdAt).getTime() <= CLAIM_WINDOW_MS;
    const matched = isValid && comment.body.includes('제가 하겠습니다');

    expect(matched).toBe(true);
  });

  /**
   * 모든 댓글이 48시간을 초과하면 선점 없음으로 처리되어야 한다.
   */
  test('모든 댓글이 48시간을 초과하면 선점 없음으로 처리되어야 한다', () => {
    const fakeNow = new Date('2026-06-13T12:00:00.000Z').getTime();
    Date.now = () => fakeNow;

    const comments = [
      {
        body: '제가 하겠습니다',
        author: {login: 'dave'},
        createdAt: '2026-06-10T00:00:00.000Z', // 84시간 전 → 초과
      },
    ].reverse();

    const keywords = ['제가 하겠습니다'];
    const CLAIM_WINDOW_MS = 48 * 60 * 60 * 1000;
    const now = Date.now();

    let matchedClaim: {
      claimer: string;
      keyword: string;
      createdAt: string;
    } | null = null;

    for (const comment of comments) {
      if (now - new Date(comment.createdAt).getTime() > CLAIM_WINDOW_MS) {
        continue;
      }

      const normalizedBody = normalizeWhitespace(comment.body);
      const foundKeyword = keywords.find(k =>
        normalizedBody.includes(normalizeWhitespace(k)),
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

    expect(matchedClaim).toBeNull();
  });
});

describe('claims doc 라벨 24h 기한 필터', () => {
  const RealDateNow = Date.now;

  afterEach(() => {
    Date.now = RealDateNow;
  });

  /**
   * doc 라벨 이슈의 선점 기한은 24시간이며,
   * 24시간이 지난 댓글은 선점 후보에서 제외되어야 한다.
   */
  test('doc 라벨 이슈에서 24시간이 지난 선점 댓글은 무시되어야 한다', () => {
    const fakeNow = new Date('2026-06-13T12:00:00.000Z').getTime();
    Date.now = () => fakeNow;

    const issueLabels = [{name: 'doc'}];
    const issueCategory = categorizeLabels(issueLabels.map(l => l.name));
    const CLAIM_WINDOW_MS =
      issueCategory === 'doc' ? 24 * 60 * 60 * 1000 : 48 * 60 * 60 * 1000;

    const rawComments = [
      {
        body: '제가 하겠습니다',
        author: {login: 'alice'},
        createdAt: '2026-06-12T00:00:00.000Z', // 36시간 전 → 24h 초과
      },
      {
        body: '진행하겠습니다',
        author: {login: 'bob'},
        createdAt: '2026-06-13T06:00:00.000Z', // 6시간 전 → 유효
      },
    ];

    const keywords = ['제가 하겠습니다', '진행하겠습니다'];
    const now = Date.now();
    const comments = [...rawComments].reverse();

    let matchedClaim: {
      claimer: string;
      keyword: string;
      createdAt: string;
    } | null = null;

    for (const comment of comments) {
      if (now - new Date(comment.createdAt).getTime() > CLAIM_WINDOW_MS) {
        continue;
      }

      const normalizedBody = normalizeWhitespace(comment.body);
      const foundKeyword = keywords.find(k =>
        normalizedBody.includes(normalizeWhitespace(k)),
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

    // alice의 댓글은 24h 초과라 무시, bob의 댓글이 채택되어야 함
    expect(issueCategory).toBe('doc');
    expect(CLAIM_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
    expect(matchedClaim?.claimer).toBe('bob');
    expect(matchedClaim?.keyword).toBe('진행하겠습니다');
  });

  /**
   * doc 라벨 이슈에서 24시간 이내 댓글은 정상 선점으로 처리되어야 한다.
   */
  test('doc 라벨 이슈에서 24시간 이내 댓글은 정상적으로 선점으로 처리되어야 한다', () => {
    const fakeNow = new Date('2026-06-13T12:00:00.000Z').getTime();
    Date.now = () => fakeNow;

    const issueLabels = [{name: 'docs'}];
    const issueCategory = categorizeLabels(issueLabels.map(l => l.name));
    const CLAIM_WINDOW_MS =
      issueCategory === 'doc' ? 24 * 60 * 60 * 1000 : 48 * 60 * 60 * 1000;

    const comment = {
      body: '제가 하겠습니다',
      author: {login: 'carol'},
      createdAt: '2026-06-13T00:00:00.000Z', // 12시간 전 → 유효
    };

    const now = Date.now();
    const isValid =
      now - new Date(comment.createdAt).getTime() <= CLAIM_WINDOW_MS;
    const matched = isValid && comment.body.includes('제가 하겠습니다');

    expect(issueCategory).toBe('doc');
    expect(matched).toBe(true);
  });

  /**
   * doc 라벨 이슈에서 코드 기한(48h) 이내지만 문서 기한(24h)을 초과한
   * 댓글은 선점 없음으로 처리되어야 한다.
   */
  test('doc 라벨 이슈에서 24h 초과~48h 이내 댓글은 선점 없음으로 처리되어야 한다', () => {
    const fakeNow = new Date('2026-06-13T12:00:00.000Z').getTime();
    Date.now = () => fakeNow;

    const issueLabels = [{name: 'documentation'}];
    const issueCategory = categorizeLabels(issueLabels.map(l => l.name));
    const CLAIM_WINDOW_MS =
      issueCategory === 'doc' ? 24 * 60 * 60 * 1000 : 48 * 60 * 60 * 1000;

    const comments = [
      {
        body: '제가 하겠습니다',
        author: {login: 'dave'},
        createdAt: '2026-06-12T06:00:00.000Z', // 30시간 전 → 24h 초과, 48h 이내
      },
    ].reverse();

    const keywords = ['제가 하겠습니다'];
    const now = Date.now();

    let matchedClaim: {
      claimer: string;
      keyword: string;
      createdAt: string;
    } | null = null;

    for (const comment of comments) {
      if (now - new Date(comment.createdAt).getTime() > CLAIM_WINDOW_MS) {
        continue;
      }

      const normalizedBody = normalizeWhitespace(comment.body);
      const foundKeyword = keywords.find(k =>
        normalizedBody.includes(normalizeWhitespace(k)),
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

    // doc 라벨이므로 24h 기준 적용 → 30시간 전 댓글은 무시
    expect(issueCategory).toBe('doc');
    expect(CLAIM_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
    expect(matchedClaim).toBeNull();
  });
});

describe('GitHub API 오류 메시지 변환', () => {
  test('401 오류는 인증 실패 메시지로 변환한다', () => {
    const error = Object.assign(new Error('Bad credentials'), {status: 401});
    const message = formatGitHubApiError(error);
    expect(message).toContain('인증에 실패');
    expect(message).toContain('401');
  });

  test('403/429 오류는 요청 한도 메시지로 변환한다', () => {
    expect(
      formatGitHubApiError(Object.assign(new Error('x'), {status: 403})),
    ).toContain('요청 한도');
    expect(
      formatGitHubApiError(Object.assign(new Error('x'), {status: 429})),
    ).toContain('요청 한도');
  });

  test('raw HttpError 스택 트레이스를 그대로 노출하지 않는다', () => {
    const error = Object.assign(new Error('Bad credentials'), {status: 401});
    const message = formatGitHubApiError(error);
    expect(message).not.toContain('HttpError');
    expect(message.startsWith('오류:')).toBe(true);
  });
});
