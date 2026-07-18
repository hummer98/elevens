/**
 * findProjectRoot({ flag }) の優先順位・存在チェック・`.team/` チェックの単体テスト。
 *
 * Task 440 で導入。`flag` 経路は strict（不在で throw）／ env / cwd-walk / fallback の
 * 既存経路は throw しない fall-through を維持することを保証する。
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, realpath } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { findProjectRoot, ProjectRootError, linkedWorktreeMainRoot, detectInvocationWorktree } from "./main";

// 各テストで env / cwd を退避・復元する
const ORIGINAL_PROJECT_ROOT = process.env.PROJECT_ROOT;
const ORIGINAL_CWD = process.cwd();

beforeEach(() => {
  delete process.env.PROJECT_ROOT;
});

afterEach(() => {
  if (ORIGINAL_PROJECT_ROOT !== undefined) {
    process.env.PROJECT_ROOT = ORIGINAL_PROJECT_ROOT;
  } else {
    delete process.env.PROJECT_ROOT;
  }
  try {
    process.chdir(ORIGINAL_CWD);
  } catch {
    // dir が消えていれば無視（他のテストの後処理で揺れた場合の保険）
  }
});

async function makeTeamProject(): Promise<{ root: string; dispose: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "cmux-team-pr-"));
  await mkdir(join(root, ".team"), { recursive: true });
  return {
    root,
    dispose: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * 主 worktree + linked worktree の最小レイアウトを組み立てる。
 * git を実行せず、`.git`（dir）/ `.git`（gitfile）/ `commondir` を手で配置する。
 *
 *   <base>/main/                 ← main root（.team/ + .git ディレクトリ）
 *          .git/worktrees/wt/commondir → "../.."
 *          .worktrees/wt/        ← linked worktree（.team/ + .git gitfile）
 */
async function makeWorktreeProject(): Promise<{
  mainRoot: string;
  worktree: string;
  dispose: () => Promise<void>;
}> {
  const base = await mkdtemp(join(tmpdir(), "cmux-team-wt-"));
  const mainRoot = join(base, "main");
  const worktree = join(mainRoot, ".worktrees", "wt");
  const wtGitDir = join(mainRoot, ".git", "worktrees", "wt");
  await mkdir(join(mainRoot, ".team"), { recursive: true });
  await mkdir(join(worktree, ".team"), { recursive: true }); // checkout された .team/ コピー
  await mkdir(wtGitDir, { recursive: true });
  await writeFile(join(wtGitDir, "commondir"), "../..\n");
  await writeFile(join(worktree, ".git"), `gitdir: ${wtGitDir}\n`);
  return {
    mainRoot,
    worktree,
    dispose: async () => {
      await rm(base, { recursive: true, force: true });
    },
  };
}

async function makePlainDir(): Promise<{ root: string; dispose: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "cmux-team-plain-"));
  return {
    root,
    dispose: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe("findProjectRoot({ flag })", () => {
  test("flag が最優先（env / cwd-walk より優先）", async () => {
    const flagProj = await makeTeamProject();
    const envProj = await makeTeamProject();
    try {
      process.env.PROJECT_ROOT = envProj.root;
      const r = findProjectRoot({ flag: flagProj.root });
      expect(r).toBe(flagProj.root);
    } finally {
      await flagProj.dispose();
      await envProj.dispose();
    }
  });

  test("flag で指定した path が存在しない → ProjectRootError (kind=not_found)", () => {
    const missing = join(tmpdir(), `cmux-team-no-such-${Date.now()}-${Math.random()}`);
    let captured: unknown;
    try {
      findProjectRoot({ flag: missing });
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(ProjectRootError);
    expect((captured as ProjectRootError).kind).toBe("not_found");
    expect((captured as Error).message).toContain("project root not found");
  });

  test("flag 指定 path に .team/ がない → ProjectRootError (kind=not_a_project)", async () => {
    const plain = await makePlainDir();
    try {
      let captured: unknown;
      try {
        findProjectRoot({ flag: plain.root });
      } catch (e) {
        captured = e;
      }
      expect(captured).toBeInstanceOf(ProjectRootError);
      expect((captured as ProjectRootError).kind).toBe("not_a_project");
      expect((captured as Error).message).toContain("not an elevens project");
    } finally {
      await plain.dispose();
    }
  });

  test("flag は path.resolve で相対パス → 絶対パスに解決される", async () => {
    const flagProj = await makeTeamProject();
    try {
      // cwd を flagProj の親に合わせて、相対パス（basename）で渡す
      const parent = join(flagProj.root, "..");
      process.chdir(parent);
      const rel = flagProj.root.split("/").pop()!;
      const r = findProjectRoot({ flag: rel });
      // realpath では symlink 差で /var ↔ /private/var の可能性があるので、basename 一致のみ確認
      expect(r.endsWith(rel)).toBe(true);
    } finally {
      await flagProj.dispose();
    }
  });

  test("flag 未指定 + env 設定あり → env 値が返る（throw しない）", async () => {
    const envProj = await makeTeamProject();
    try {
      process.env.PROJECT_ROOT = envProj.root;
      const r = findProjectRoot();
      expect(r).toBe(envProj.root);
    } finally {
      await envProj.dispose();
    }
  });

  test("flag 未指定 + env なし + cwd-walk hit → walk 結果が返る（throw しない）", async () => {
    const proj = await makeTeamProject();
    try {
      // proj 直下に subdir を作って cwd を移動
      const sub = join(proj.root, "a", "b");
      await mkdir(sub, { recursive: true });
      process.chdir(sub);
      const r = findProjectRoot();
      // realpath 差を吸収するため、basename 一致をゆるく確認
      expect(r.endsWith(proj.root.split("/").pop()!)).toBe(true);
    } finally {
      await proj.dispose();
    }
  });

  test("flag 未指定 + 全部 miss → cwd fallback（throw しない）", async () => {
    const plain = await makePlainDir();
    try {
      process.chdir(plain.root);
      // env 未設定 / .team/ なし
      const r = findProjectRoot();
      // fallback は process.cwd() なので plain.root と prefix が一致
      expect(r.endsWith(plain.root.split("/").pop()!)).toBe(true);
    } finally {
      await plain.dispose();
    }
  });

  test("linked worktree 配下 → main root へ自動アタッチする", async () => {
    const proj = await makeWorktreeProject();
    try {
      process.chdir(proj.worktree);
      const r = findProjectRoot();
      expect(await realpath(r)).toBe(await realpath(proj.mainRoot));
    } finally {
      await proj.dispose();
    }
  });

  test("linked worktree の subdir 配下でも main root へ自動アタッチする", async () => {
    const proj = await makeWorktreeProject();
    try {
      const sub = join(proj.worktree, "skills", "cmux-team");
      await mkdir(sub, { recursive: true });
      process.chdir(sub);
      const r = findProjectRoot();
      expect(await realpath(r)).toBe(await realpath(proj.mainRoot));
    } finally {
      await proj.dispose();
    }
  });
});

describe("linkedWorktreeMainRoot / detectInvocationWorktree", () => {
  test("linkedWorktreeMainRoot: worktree root → main root を返す", async () => {
    const proj = await makeWorktreeProject();
    try {
      const r = linkedWorktreeMainRoot(proj.worktree);
      expect(r).not.toBeNull();
      expect(await realpath(r!)).toBe(await realpath(proj.mainRoot));
    } finally {
      await proj.dispose();
    }
  });

  test("linkedWorktreeMainRoot: 主 worktree（.git が dir）→ null", async () => {
    const proj = await makeWorktreeProject();
    try {
      // mainRoot は .git ディレクトリを持つので null
      expect(linkedWorktreeMainRoot(proj.mainRoot)).toBeNull();
    } finally {
      await proj.dispose();
    }
  });

  test("linkedWorktreeMainRoot: 非 git ディレクトリ → null", async () => {
    const plain = await makePlainDir();
    try {
      expect(linkedWorktreeMainRoot(plain.root)).toBeNull();
    } finally {
      await plain.dispose();
    }
  });

  test("detectInvocationWorktree: worktree subdir → worktree root を返す", async () => {
    const proj = await makeWorktreeProject();
    try {
      const sub = join(proj.worktree, "a", "b");
      await mkdir(sub, { recursive: true });
      expect(await realpath(detectInvocationWorktree(sub)!)).toBe(await realpath(proj.worktree));
    } finally {
      await proj.dispose();
    }
  });

  test("detectInvocationWorktree: 主 worktree 配下 → null", async () => {
    const proj = await makeWorktreeProject();
    try {
      expect(detectInvocationWorktree(proj.mainRoot)).toBeNull();
    } finally {
      await proj.dispose();
    }
  });
});
