import {cac} from 'cac';
import {createGitHubService} from './github-service';

const cli = cac('reposcore-ts');

cli
  .command('[...repos]', '대상 저장소 목록 (예: owner/repo1 owner/repo2)')
  .option('--token <token>', 'GitHub Personal Access Token', {
    default: '$GITHUB_TOKEN',
  })
  .option('--format <format>', '출력 형식 (csv, txt)', {
    default: 'csv',
  })
  .action(
    async (repos: string[], options: {token?: string; format: string}) => {
      const token =
        options.token === '$GITHUB_TOKEN'
          ? Bun.env.GITHUB_TOKEN
          : options.token;

      if (!token) {
        console.error(
          '오류: GitHub 토큰이 필요합니다. --token 옵션 또는 GITHUB_TOKEN 환경 변수를 설정하세요.',
        );
        return;
      }

      if (repos.length === 0) {
        console.error(
          '오류: 최소 하나 이상의 저장소(owner/repo)를 입력해야 합니다.',
        );
        cli.outputHelp();
        return;
      }

      console.log('분석 기능 구현 중입니다.');
      console.log(`저장소: ${repos.join(', ')}`);
      console.log(`형식: ${options.format}`);

      const githubService = createGitHubService(token);

      let hasError = false;

      for (const repoPath of repos) {
        const parts = repoPath.split('/');

        if (parts.length !== 2 || !parts[0] || !parts[1]) {
          console.error(
            `오류: '${repoPath}'는 'owner/repo' 형식이 아닙니다. 건너뜀.`,
          );
          hasError = true;
          continue;
        }

        const [owner, repoName] = parts;

        try {
          const stats = await githubService.getRepoStats(owner, repoName);

          console.log(
            `[${repoPath}] 이슈: ${stats.issues}, PR: ${stats.pullRequests}`,
          );
        } catch (error: unknown) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          console.error(`오류: '${repoPath}'의 데이터를 가져올 수 없습니다.`);
          console.error(`상세 원인: ${errorMessage}`);
          hasError = true;
        }
      }

      if (hasError) {
        process.exitCode = 1;
      }
    },
  );

cli.help();
cli.parse();
