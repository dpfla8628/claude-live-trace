import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import {
  citedCommits,
  countActions,
  evidenceOf,
  hookLine,
  hostLevel,
  hostWarning,
  isEnglish,
  labelOf,
  parseHost,
  spark,
  linesOf,
  parseNarration,
  phaseOf,
  sourceOf,
  storyText,
  upsertLog,
} from './describe'

const PANE = {
  plugin: 'live-trace',
  component: 'Pane',
  requestId: 'live-trace',
  props: {
    title: '작업 과정',
    isFocused: false,
    bodyColumns: 52,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

describe('한국어 동작 이름과 단계', () => {
  test('도구마다 한국어 이름 · 단계', async () => {
    const cases: [string, Record<string, unknown>, string, string][] = [
      // 파일은 이름 대신 종류로, 한글 이름만 붙인다
      ['Read', { file_path: 'C:\\repo\\src\\Button.tsx' }, '소스 확인', 'explore'],
      ['Read', { file_path: 'C:/Users/u/.claude/projects/p/memory/feedback_design_priority.md' }, '지침 메모 확인', 'guide'],
      ['Read', { file_path: '/repo/CLAUDE.md' }, '프로젝트 규칙 확인', 'guide'],
      ['Read', { file_path: 'C:\\proj\\.claude\\skills\\디자인-반영\\점검.ai.md' }, 'AI 문서 「점검」 확인', 'guide'],
      ['Read', { file_path: '/a/.claude/skills/orca-cli/SKILL.md' }, '스킬 문서 확인', 'guide'],
      ['Edit', { file_path: '/repo/Button.tsx', old_string: 'a', new_string: 'b\nc' }, '소스 고치기 +2 -1', 'change'],
      ['Bash', { command: 'git log --oneline -L 1,5:Button.tsx', description: 'Show history' }, '변경 이력 보기', 'explore'],
      ['Bash', { command: 'npx tsc -p .', description: '타입 검사' }, '타입 검사', 'verify'],
      ['Bash', { command: 'npm test', description: '' }, '테스트 돌리기', 'verify'],
      ['Bash', { command: 'git commit -m x', description: '' }, '커밋하기', 'change'],
      ['Bash', { command: 'ls -al', description: '폴더 안 파일 보기' }, '폴더 안 파일 보기', 'explore'],
      ['Skill', { skill: '디자인-반영' }, '「디자인-반영」 스킬 불러오기', 'guide'],
      // 검색: 낱말은 보여 주고 정규식은 「코드에서 찾기」
      ['Grep', { pattern: 'radius' }, '「radius」 찾기', 'explore'],
      ['Grep', { pattern: 'export (default )?function' }, '코드에서 찾기', 'explore'],
      ['Glob', { pattern: '**/Button*.tsx' }, '파일 찾기', 'explore'],
      ['mcp__figma__get_screenshot', { nodeId: '12:34' }, '피그마 화면 캡처', 'guide'],
      ['mcp__jira__jira_add_comment', { issue_key: 'ABC-1' }, '지라에 쓰기', 'change'],
      ['mcp__jira__confluence_get_page', { page_id: '1' }, '위키에서 확인', 'guide'],
      ['mcp__claude-in-chrome__computer', {}, '크롬 화면 조작', 'verify'],
      ['Agent', { subagent_type: 'Explore', description: '버튼 코드 찾기' }, '탐색 도우미에게 맡김: 버튼 코드 찾기', 'explore'],
    ]
    for (const [tool, args, label, phase] of cases) {
      expect(labelOf(tool, args)).toBe(label)
      expect(phaseOf(tool, args)).toBe(phase)
    }
  })

  test('git log 결과에서 커밋 줄을 뽑는다', async () => {
    const out = 'a1b2c3d4e radius 토큰 통일\n9f8e7d6 버튼 추가\n'
    const ev = evidenceOf('Bash', { command: 'git log --oneline Button.tsx' }, out, 1)
    expect(ev.map(x => x.text)).toEqual(['a1b2c3d4 radius 토큰 통일', '9f8e7d6 버튼 추가'])
    expect(ev[0]?.kind).toBe('commit')
    // 날짜 · 시각 · 작성자 머리는 떼고 병합 커밋은 뺀다
    const log = [
      '135098ba 2026-11-16 17:26:59 +0900 ABC-197 카드 헤더 줄바꿈',
      'c401a9fe 2026-11-19 Merge branch x',
      '80687825 2026-11-16 홍길동 | ABC-197 현황 비교 v4',
    ].join('\n')
    expect(evidenceOf('Bash', { command: 'git log --format=x' }, log, 1).map(x => x.text)).toEqual([
      '135098ba ABC-197 카드 헤더 줄바꿈',
      '80687825 ABC-197 현황 비교 v4',
    ])
  })

  test('지침은 한글 이름으로: 메모는 목차 제목, 스킬 안 AI 문서는 스킬 이름과 함께, 소스는 근거 아님', async () => {
    const index = '- [디자인 우선순위](feedback_design_priority.md) — 디자이너 > 현행\n- [Commit — no AI](feedback_commit.md) — x'
    const texts = (path: string, idx = '') => evidenceOf('Read', { file_path: path }, '', 1, idx).map(x => `${x.kind}:${x.text}`)
    expect(texts('C:\\p\\memory\\feedback_design_priority.md', index)).toEqual(['guide:디자인 우선순위'])
    expect(texts('/p/memory/feedback_commit.md', index)).toEqual([])
    expect(texts('/a/.claude/skills/디자인-반영/점검.ai.md')).toEqual(['skill:디자인-반영', 'guide:점검 (디자인-반영 스킬)'])
    expect(texts('/a/.claude/skills/디자인-반영/SKILL.md')).toEqual(['skill:디자인-반영'])
    expect(texts('/repo/Button.tsx')).toEqual([])
  })

  test('판단 근거 커밋은 최종 답이 든 것, 없으면 마지막 3개', async () => {
    const commits = ['2a9b34ac 처음 만듦', '135098ba 헤더 줄바꿈', 'dc3f1a2b 전부 6', '6b93700b 칸 높이']
    expect(citedCommits(commits, '2a9b34ac 에서 8, dc3f1a2 에서 6 으로')).toEqual(['2a9b34ac 처음 만듦', 'dc3f1a2b 전부 6'])
    expect(citedCommits(commits, '')).toEqual(['135098ba 헤더 줄바꿈', 'dc3f1a2b 전부 6', '6b93700b 칸 높이'])
  })

  test('문장에서 제목 · 단계 · 지침을 꺼낸다', async () => {
    const said = parseNarration('설명은 위에.\n\n**[2/4] 피그마 원본과 비교합니다 (지침: 디자인 우선순위)**')
    expect(said.title).toBe('피그마 원본과 비교합니다')
    expect(said.step).toEqual({ n: 2, m: 4 })
    expect(said.guides).toEqual(['디자인 우선순위'])
    expect(parseNarration('README.md를 읽습니다. 그래야 성격을 압니다.').title).toBe('README.md를 읽습니다.')
    // 첫 숫자는 남기고 목록 머리만 뗀다
    expect(parseNarration('[2/3] 6이라는 숫자를 정한 자리를 봅니다').title).toBe('6이라는 숫자를 정한 자리를 봅니다')
    expect(parseNarration('1. 버튼부터 봅니다').title).toBe('버튼부터 봅니다')
  })

  test('동작은 파일 이름 대신 종류별 개수로, 줄 수는 한글 2칸으로 센다', async () => {
    const src = (tool: string, a: Record<string, unknown> = {}) => sourceOf(tool, a)
    expect(src('Bash', { command: 'git log -L 1,5:a.tsx' })).toBe('변경 이력')
    expect(src('mcp__confluence__confluence_get_page')).toBe('위키')
    expect(src('ToolSearch')).toBe('')
    // 지침 → 소스 → 동작 순서
    expect(countActions(['소스', '소스', '검색', '명령', '소스', '지침 메모', '고침', ''])).toEqual([
      '지침 메모 1개',
      '소스 3개',
      '검색 1번',
      '명령 1번',
      '1곳 고침',
    ])
    expect(linesOf('가'.repeat(30), 40)).toBe(2)
    expect(linesOf('a'.repeat(30), 40)).toBe(1)
  })

  test('작업 설명 글', async () => {
    const text = storyText({
      task: 1,
      at: 0,
      where: 'proj',
      request: '이 네모 버튼 이상해',
      status: 'answer',
      skills: [{ kind: 'skill', text: '디자인-반영' }],
      guides: [{ kind: 'guide', text: '디자인 우선순위', why: '판단 기준을 먼저 잡습니다' }],
      basis: [{ kind: 'commit', text: 'a1b2c3d4 radius 토큰 통일' }],
      hooks: [{ task: 1, group: 0, act: 'note', at: '요청', text: '존댓말로 답할 것.', count: 1 }],
      steps: ['네모가 된 이유부터 찾습니다', 'radius 를 원으로 고칩니다'],
      checks: ['타입 검사 통과'],
      unverified: false,
      sources: ['소스 12개', '검색 3번'],
      explored: '소스 12개, 검색 3번',
      ms: 130_000,
    })
    expect(text).toContain('- 쓴 스킬: 디자인-반영')
    expect(text).toContain('- 따른 지침: 디자인 우선순위 (왜: 판단 기준을 먼저 잡습니다)')
    expect(text).toContain('- 훅 · 규칙: 요청 때 지시를 덧붙임: 존댓말로 답할 것.')
    // 기록 파일엔 해시까지 남겨 「어떻게 했어?」에 답할 수 있게
    expect(text).toContain('- 근거: a1b2c3d4 radius 토큰 통일')
    expect(text).toContain('- 확인한 것: 소스 12개, 검색 3번 (걸린 시간 2분 10초)')
    expect(text).toContain('  2. radius 를 원으로 고칩니다')
    expect(text).toContain('- 검증: 타입 검사 통과')
    expect(text).toMatch(/^### \d\d:\d\d \[proj\] 이 네모 버튼 이상해/)
  })

  test('기록 파일: 같은 작업은 한 절을 새로 쓰고, 다른 작업은 끝에 붙인다', async () => {
    const one = upsertLog('# 작업 기록\n', '100', '### 첫 작업 (중간)')
    expect(one).toBe('# 작업 기록\n\n<!-- live-trace:100 -->\n### 첫 작업 (중간)\n')
    const two = upsertLog(one, '200', '### 둘째 작업')
    const again = upsertLog(two, '100', '### 첫 작업 (끝)')
    expect(again).toContain('### 첫 작업 (끝)')
    expect(again).not.toContain('(중간)')
    expect(again.indexOf('첫 작업')).toBeLessThan(again.indexOf('둘째 작업'))
    expect(again.split('<!-- live-trace:').length).toBe(3)
  })
})

type Ran = { exitCode: number; stdout: string; stderr: string }
const engine = (on: On, opts: { env?: Record<string, string>; run?: (argv: readonly string[]) => Ran } = {}) => {
  // 디스크 · 메모리 재기 · 정리 명령: 답을 안 주면 실패로(패널은 그 줄만 뺀다)
  on('process.run', (_, e) => ({
    value: { isStdoutTruncated: false, isStderrTruncated: false, ...(opts.run?.(e.argv) ?? { exitCode: 1, stdout: '', stderr: '' }) },
  }))
  on('command.register', () => ({ value: { command: 'trace' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 1000, percent: 45 }, rateLimits: [{ kind: 'five_hour', percentUsed: 23 }] },
  }))
  on('env.get', (_, e) => ({ value: opts.env?.[e.name] }))
  on('clock.every', () => ({ value: () => undefined }) as never)
  let now = 1000
  on('clock.now', () => ({ value: (now += 100) }))
}

// 도구 조각 하나를 부르는 응답: 생각(무시돼야 함) → 앞 문장 → 도구
const say = (text: string, id: string, name: string, index = 0, turnId = 't1') =>
  async function* () {
    yield { kind: 'thinking', index: 0, text: '비밀 생각' } as const
    yield { kind: 'text', index: 1, text } as const
    yield { kind: 'tool', index: 2, id, name } as const
    return { turnId, index, answer: text, toolUses: [], stopReason: 'tool_use' } as never
  }

const drain = async (s: AsyncIterable<unknown>) => {
  for await (const _ of s) void _
}

test('흐름: 지난 단계는 요약 한 줄, 지금 단계는 하는 일 + 경과 시간, 근거엔 파일 이름 없음', async ($, on) => {
  engine(on)
  let reply = say('[1/3] 네모가 된 이유부터 찾으려고 버튼 파일의 변경 이력을 보고 관련 파일을 여러 개 훑어봅니다', 'u1', 'Bash')
  on('turn.step', async function* () {
    return yield* reply()
  })
  let finishTool: (() => void) | undefined
  on('tool.call', async (_, e) =>
    String(e.tool) === 'Read' && String((e as { file_path?: string }).file_path).endsWith('Button.tsx')
      ? await new Promise(r => {
          finishTool = () => r({ result: {}, text: '' })
        })
      : { result: {}, text: 'a1b2c3d4e radius 토큰 통일\n' },
  )

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '이 네모 버튼 이상해', turnId: 't1' })
  await drain($.turn.step({ turnId: 't1', index: 0, model: 'opus', messageCount: 1 }))
  await $.tool.call({ tool: 'Bash', command: 'git log --oneline Button.tsx', description: 'history', tool_use_id: 'u1' } as never)
  await $.tool.call({ tool: 'Read', file_path: '/repo/a.tsx', tool_use_id: 'u1b' } as never)
  await $.tool.call({ tool: 'Read', file_path: '/repo/b.tsx', tool_use_id: 'u1c' } as never)

  reply = say('[2/3] 버튼 파일을 읽습니다 (지침: 디자인 우선순위)', 'u2', 'Read', 1)
  await drain($.turn.step({ turnId: 't1', index: 1, model: 'opus', messageCount: 2 }))
  const reading = $.tool.call({ tool: 'Read', file_path: '/repo/Button.tsx', tool_use_id: 'u2' } as never)
  for (let i = 0; i < 10_000 && finishTool === undefined; i++) await Promise.resolve()

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^지금 / }))?.text).toMatch(/^지금 소스 확인 중 {2}\d+초$/)
    expect((await ui.find({ text: /2\/3단계 50%/ })) !== undefined).toBe(true)
    // 지난 단계: 문장 전체(자르지 않음) + 종류별 개수
    expect((await ui.find({ type: 'Text', text: /\[1\/3\]/ }))?.text).toBe(
      '✓ [1/3] 네모가 된 이유부터 찾으려고 버튼 파일의 변경 이력을 보고 관련 파일을 여러 개 훑어봅니다',
    )
    expect((await ui.find({ type: 'Text', text: /변경 이력 1번/ }))?.text).toBe('변경 이력 1번, 소스 2개')
    // 지금 단계: 하는 일 + 경과 시간
    expect((await ui.find({ type: 'Text', text: /\[2\/3\]/ }))?.text).toBe('▸ [2/3] 버튼 파일을 읽습니다')
    expect((await ui.find({ type: 'Text', text: /^⊷/ }))?.text).toMatch(/^⊷ 소스 확인 중 \d+초$/)
    expect((await ui.find({ text: /남은 단계 1개/ })) !== undefined).toBe(true)
    // 판단 근거: 무엇을 봤나 + 「왜:」(그 단계에서 쓴 문장). 해시 · 파일 이름은 없음
    expect((await ui.find({ type: 'Text', text: /^변경 기록/ }))?.text).toBe('변경 기록 「radius 토큰 통일」')
    expect((await ui.find({ type: 'Text', text: /^왜: 네모가/ }))?.text).toBe(
      '왜: 네모가 된 이유부터 찾으려고 버튼 파일의 변경 이력을 보고 관련 파일을 여러 개 훑어봅니다',
    )
    expect(await ui.find({ text: /a1b2c3d4/ })).toBe(undefined)
    // 지침은 그 단계 바로 아래에
    expect((await ui.find({ type: 'Text', text: /^지침 / }))?.text).toBe('지침 디자인 우선순위')
    expect(await ui.find({ text: /a\.tsx|b\.tsx|Button\.tsx/ })).toBe(undefined)
    expect((await ui.find({ type: 'Text', text: /대화 용량/ }))?.text).toBe('Opus 5.5 | 대화 용량 45% | 5시간 한도 23%')
    expect(await ui.find({ text: /비밀 생각/ })).toBe(undefined)
    expect(await ui.find({ text: /Bash|Read/ })).toBe(undefined)
    await ui.unmount()
  }
  finishTool?.()
  await reading
})

test('단계를 누르면 펼쳐져 동작 하나하나가 보이고, 다시 누르면 접힌다', async ($, on) => {
  engine(on)
  on('turn.step', async function* () {
    return yield* say('[1/1] 폴더를 훑어봅니다', 'u1', 'Read')()
  })
  on('tool.call', () => ({ result: {}, text: '' }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '훑어봐', turnId: 't1' })
  await drain($.turn.step({ turnId: 't1', index: 0, model: 'opus', messageCount: 1 }))
  for (const n of [1, 2, 3, 4, 5]) {
    await $.tool.call({ tool: 'Read', file_path: `/repo/f${n}.ts`, tool_use_id: n === 1 ? 'u1' : `u${n}` } as never)
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /소스 5개/ }))?.text).toBe('지금까지 소스 5개')
  expect(await ui.find({ type: 'Text', text: /f1\.ts/ })).toBe(undefined)
  // 펼치면 동작마다 한 줄, 파일 이름은 흐리게 뒤에
  await ui.press({ key: 'step-1' })
  expect((await ui.find({ type: 'Text', text: /f1\.ts/ }))?.text).toBe('✓ 소스 확인  f1.ts')
  await ui.press({ key: 'step-1' })
  expect(await ui.find({ type: 'Text', text: /f1\.ts/ })).toBe(undefined)
  await ui.unmount()
})

test('끝나면 작업 설명(걸린 시간 · 살펴본 것), 바꾼 뒤 검증이 없으면 경고, /trace 설명 은 글로', async ($, on) => {
  engine(on)
  on('turn.step', async function* () {
    return yield* say('반지름을 원으로 고칩니다', 'u1', 'Edit')()
  })
  on('tool.call', () => ({ result: {}, text: '' }))
  on('skill.prompt', (_, e) => ({ text: e.text }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '이 네모 버튼 이상해', turnId: 't1' })
  await drain($.turn.step({ turnId: 't1', index: 0, model: 'opus', messageCount: 1 }))
  await $.skill.prompt({ skill: '디자인-반영', text: '...', frontmatter: {} } as never)
  await $.tool.call({ tool: 'Read', file_path: '/repo/Button.tsx', tool_use_id: 'u0' } as never)
  await $.tool.call({ tool: 'Edit', file_path: '/repo/Button.tsx', old_string: 'a', new_string: 'b', tool_use_id: 'u1' } as never)
  await $.turn.complete({ answer: '', durationMs: 75_000, isAborted: false, turnId: 't1', reason: 'answer' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^작업 설명/ }))?.text).toBe('작업 설명  끝남, 1분 15초')
  // 제목 아래 한 줄에 하나씩
  for (const t of ['요청', '이 네모 버튼 이상해', '쓴 스킬', '디자인-반영', '확인한 것', '소스 1개', '1곳 고침', '검증']) {
    expect((await ui.find({ type: 'Text', text: t }))?.text).toBe(t)
  }
  expect(await ui.find({ type: 'Text', text: /판단 근거|따른 지침/ })).toBe(undefined)
  expect((await ui.find({ type: 'Text', text: /검증하지 않았습니다/ }))?.text).toBe('✗ 바꾼 뒤 검증하지 않았습니다')
  await ui.unmount()

  const r = await $.command.run({ command: 'trace', args: '설명' } as never)
  expect(r.text).toContain('- 쓴 스킬: 디자인-반영')
  expect(r.text).toContain('- 확인한 것: 소스 1개, 1곳 고침 (걸린 시간 1분 15초)')
  expect(r.text).toContain('  1. 반지름을 원으로 고칩니다')
  expect(r.text).toContain('- 검증: 바꾼 뒤 검증하지 않음')
})

test('끝난 카드: 긴 요청은 첫 문장, 지침은 메모 목차의 한글 제목, 근거는 한 줄에 하나', async ($, on) => {
  engine(on)
  on('fs.read', () => ({ value: '- [디자인 우선순위](feedback_design_priority.md) — 디자이너 > 현행' }))
  on('tool.call', (_, e) =>
    String(e.tool) === 'Bash'
      ? { result: {}, text: 'a1b2c3d4e radius 토큰 통일\n9f8e7d6 버튼 추가\n' }
      : { result: {}, text: '' },
  )

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'Card 모서리가 왜 이 값인지 찾아줘. 파일은 고치지 말고 끝까지 해줘.', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: 'C:\\u\\memory\\feedback_design_priority.md', tool_use_id: 'u1' } as never)
  await $.tool.call({ tool: 'Read', file_path: '/a/.claude/skills/디자인-반영/점검.ai.md', tool_use_id: 'u2' } as never)
  await $.tool.call({ tool: 'Bash', command: 'git log --oneline Card.tsx', description: '변경 이력 보기', tool_use_id: 'u3' } as never)
  await $.tool.call({ tool: 'Read', file_path: '/repo/Card.tsx', tool_use_id: 'u4' } as never)
  await $.turn.complete({ answer: '', durationMs: 5000, isAborted: false, turnId: 't1', reason: 'answer' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  for (const t of [
    'Card 모서리가 왜 이 값인지 찾아줘.',
    '디자인-반영',
    '디자인 우선순위',
    '점검 (디자인-반영 스킬)',
    '변경 기록 「radius 토큰 통일」',
    '변경 기록 「버튼 추가」',
    '지침 메모 1개',
    'AI 문서 1개',
    '변경 이력 1번',
    '소스 1개',
    '◦ 검증할 변경 없음',
  ]) {
    expect((await ui.find({ type: 'Text', text: t }))?.text).toBe(t)
  }
  expect(await ui.find({ text: /feedback_|\.ai\.md|끝까지 해줘/ })).toBe(undefined)
  await ui.unmount()
})

test('검증 뒤 문서(.md)만 고친 것은 「검증 안 함」 경고를 띄우지 않는다', async ($, on) => {
  engine(on)
  on('tool.call', () => ({ result: {}, text: '' }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '버튼 고쳐줘', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/Button.tsx', old_string: 'a', new_string: 'b', tool_use_id: 'u1' } as never)
  await $.tool.call({ tool: 'Bash', command: 'npx tsc -p .', description: '타입 검사', tool_use_id: 'u2' } as never)
  await $.tool.call({ tool: 'Edit', file_path: '/memo/note.md', old_string: 'a', new_string: 'b', tool_use_id: 'u3' } as never)
  await $.turn.complete({ answer: '', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /검증하지 않았습니다/ })).toBe(undefined)
  expect((await ui.find({ type: 'Text', text: /타입 검사/ }))?.text).toBe('✓ 타입 검사 통과')
  await ui.unmount()
})

test('표시 없는 문장은 큰 단계의 세부 단계: 진행 중엔 보이고, 끝나면 요약으로 접히고 + 로 펼친다', async ($, on) => {
  engine(on)
  let reply = say('[1/2] 폴더부터 봅니다', 'u1', 'Glob')
  on('turn.step', async function* () {
    return yield* reply()
  })
  on('tool.call', () => ({ result: {}, text: '' }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '살펴봐', turnId: 't1' })
  await drain($.turn.step({ turnId: 't1', index: 0, model: 'opus', messageCount: 1 }))
  await $.tool.call({ tool: 'Glob', pattern: '*', tool_use_id: 'u1' } as never)
  reply = say('진입 파일이 안 보여서 한 번 더 찾습니다', 'u2', 'Grep', 1)
  await drain($.turn.step({ turnId: 't1', index: 1, model: 'opus', messageCount: 2 }))
  await $.tool.call({ tool: 'Grep', pattern: 'main', tool_use_id: 'u2' } as never)
  const mid = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await mid.find({ type: 'Text', text: /^↳ 진입/ }))?.text).toBe('↳ 진입 파일이 안 보여서 한 번 더 찾습니다')
  await mid.unmount()
  reply = say('[2/2] 진입 파일을 읽습니다', 'u3', 'Read', 2)
  await drain($.turn.step({ turnId: 't1', index: 2, model: 'opus', messageCount: 3 }))
  await $.tool.call({ tool: 'Read', file_path: '/repo/main.py', tool_use_id: 'u3' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /세부 단계/ }))?.text).toBe('검색 2번, 세부 단계 1개')
  expect(await ui.find({ type: 'Text', text: /진입 파일이 안 보여서/ })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /\(2\)/ })).toBe(undefined)
  await ui.press({ key: 'step-1' })
  expect((await ui.find({ type: 'Text', text: /진입 파일이 안 보여서/ }))?.text).toBe('↳ 진입 파일이 안 보여서 한 번 더 찾습니다')
  await ui.unmount()
})

test('백그라운드 셸 · 도우미가 무엇을 하는지 보인다', async ($, on) => {
  engine(on)
  on('tool.call', () => ({ result: {}, text: '' }))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '테스트 돌려줘', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'npm test', description: '전체 테스트 돌리기', run_in_background: true, tool_use_id: 'u1' } as never)
  await $.agent.spawn({ tool_use_id: 'u2', subagentType: 'Explore', description: '버튼 코드 찾기', prompt: 'x' } as never)
  await $.tool.call({ tool: 'Grep', pattern: 'radius', agentId: 'a1', tool_use_id: 'u3' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^⊷ 전체 테스트/ }))?.text).toBe('⊷ 전체 테스트 돌리기')
  // 도우미마다 따로: 동작 수 · 경과 시간
  expect((await ui.find({ type: 'Text', text: /탐색 도우미/ }))?.text).toMatch(/^⊷ 탐색 도우미: 버튼 코드 찾기 {2}동작 1번, \d+초$/)
  expect((await ui.find({ type: 'Text', text: /↳ 「radius」/ }))?.text).toBe('↳ 「radius」 찾기')
  await ui.unmount()
})

test('요청마다 작업 하나: 새 요청이 와도 지난 작업은 목록에 남고, 번호를 눌러 오간다', async ($, on) => {
  engine(on)
  let reply = say('[1/2] 버튼 파일을 봅니다', 'u1', 'Read')
  on('turn.step', async function* () {
    return yield* reply()
  })
  on('tool.call', () => ({ result: {}, text: '' }))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))

  await $.session.start({ cwd: 'C:\\work\\proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '이 네모 버튼 이상해', turnId: 't1' })
  await drain($.turn.step({ turnId: 't1', index: 0, model: 'opus', messageCount: 1 }))
  await $.tool.call({ tool: 'Read', file_path: '/repo/Button.tsx', tool_use_id: 'u1' } as never)
  // 1번 작업이 띄운 도우미는 2번 작업이 시작해도 1번 작업 것
  await $.agent.spawn({ tool_use_id: 'u1x', subagentType: 'Explore', description: '버튼 쓰는 화면 찾기', prompt: 'x' } as never)
  await $.turn.complete({ answer: '', durationMs: 60_000, isAborted: false, turnId: 't1', reason: 'answer' } as never)

  reply = say('[1/3] 높이 값을 찾습니다', 'u2', 'Grep', 1, 't2')
  await $.turn.start({ text: '버튼 높이도 맞춰줘', turnId: 't2' })
  await drain($.turn.step({ turnId: 't2', index: 1, model: 'opus', messageCount: 2 }))
  await $.tool.call({ tool: 'Grep', pattern: 'height', tool_use_id: 'u2' } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // 1번은 끝났지만 도우미가 돌아서 둘 다 「진행 중」 상자
    expect((await ui.find({ type: 'Text', text: /^진행 중/ }))?.text).toBe('진행 중 2개')
    expect(await ui.find({ type: 'Text', text: /^끝난 작업/ })).toBe(undefined)
    expect((await ui.find({ type: 'Text', text: /버튼 높이도/ }))?.text).toBe('▸ 버튼 높이도 맞춰줘  17%  보는 중')
    // 1번 작업은 끝났지만 도우미가 아직 돌아서 「뒤에서 계속」
    expect((await ui.find({ type: 'Text', text: /네모 버튼/ }))?.text).toBe('⊷ 이 네모 버튼 이상해  뒤에서 계속')
    expect((await ui.find({ text: /1\/3단계 17%/ })) !== undefined).toBe(true)
    expect((await ui.find({ type: 'Text', text: /탐색 도우미/ }))?.text).toMatch(/^⊷ 탐색 도우미: 버튼 쓰는 화면 찾기 {2}1번 작업, 동작 0번, /)
    // 1번을 누르면 1번의 작업 설명과 흐름
    await ui.press({ key: 'task-1' })
    expect((await ui.find({ type: 'Text', text: /작업 설명/ }))?.text).toBe('1번 작업 설명  끝남, 1분 0초')
    expect((await ui.find({ type: 'Text', text: /\[1\/2\]/ }))?.text).toBe('✓ [1/2] 버튼 파일을 봅니다')
    expect(await ui.find({ type: 'Text', text: /높이 값을 찾습니다/ })).toBe(undefined)
    // 2번을 누르면 다시 지금 작업
    await ui.press({ key: 'task-2' })
    expect((await ui.find({ type: 'Text', text: /\[1\/3\]/ }))?.text).toBe('▸ [1/3] 높이 값을 찾습니다')
    await ui.unmount()
  }
  // 2번이 끝나면 「끝난 작업」 상자로 옮겨 간다
  await $.turn.complete({ answer: '', durationMs: 5000, isAborted: false, turnId: 't2', reason: 'answer' } as never)
  const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await after.find({ type: 'Text', text: /^진행 중/ }))?.text).toBe('진행 중 1개')
  expect((await after.find({ type: 'Text', text: /^끝난 작업/ }))?.text).toBe('끝난 작업 1개')
  expect((await after.find({ type: 'Text', text: /버튼 높이도/ }))?.text).toBe('✓ 버튼 높이도 맞춰줘  끝남, 5초  보는 중')
  await after.unmount()
})

test('훅이 한 일: 막으면 그 단계 아래 빨간 ⚑, 요청에 덧붙인 지시 · 불러온 규칙은 위에, 끝나면 카드의 「훅 · 규칙」', async ($, on) => {
  engine(on)
  on('turn.step', async function* () {
    return yield* say('[1/2] 디스크 상태를 봅니다', 'u1', 'Bash')()
  })
  on('tool.call', () => ({ result: {}, text: '' }))
  on('classic.PreToolUse', () => ({
    deny: "resource-guard: 메모리/디스크 위험 수준(cpu=39% disk=0.3GB)이 45s 동안 안 풀려 'Bash' 호출을 보류했습니다. 줄인 뒤 다시 시도하세요.",
  }))
  on('classic.UserPromptSubmit', () => ({ additionalContext: ['존댓말로 답할 것. 반말은 쓰지 않는다.'] }))
  on('classic.InstructionsLoaded', () => ({}))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  // 규칙 문서 · 요청 훅은 작업이 시작되기 전에 돈다 → 그 작업이 가져간다
  await $.classic.InstructionsLoaded({
    file_path: 'C:\\Users\\u\\.claude\\CLAUDE.md',
    memory_type: 'User',
    load_reason: 'session_start',
  } as never)
  await $.classic.UserPromptSubmit({ prompt: '디스크 봐줘' } as never)
  await $.turn.start({ text: '디스크 봐줘', turnId: 't1' })
  await drain($.turn.step({ turnId: 't1', index: 0, model: 'opus', messageCount: 1 }))
  await $.tool.call({ tool: 'Bash', command: 'df -h', description: '디스크 보기', tool_use_id: 'u1' } as never)
  await $.tool.call({ tool: 'Bash', command: 'df -h', description: '디스크 보기', tool_use_id: 'u1b' } as never)

  const blocked = "막음: resource-guard: 메모리/디스크 위험 수준이 45s 동안 안 풀려 'Bash' 호출을 보류했습니다. (2번)"
  const loaded = '규칙 문서를 불러옴: CLAUDE.md (사용자 전체 · 세션 시작)'
  const mid = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await mid.find({ type: 'Text', text: /^⚑ 훅이 요청/ }))?.text).toBe('⚑ 훅이 요청 때 지시를 덧붙임: 존댓말로 답할 것.')
  // 규칙 문서는 훅이 한 일이 아니라 「훅이」를 붙이지 않는다
  expect((await mid.find({ type: 'Text', text: /^⚑ 규칙 문서/ }))?.text).toBe(`⚑ ${loaded}`)
  expect((await mid.find({ type: 'Text', text: /^⚑ 훅이 막음/ }))?.text).toBe(`⚑ 훅이 ${blocked}`)
  expect(await mid.find({ text: /cpu=/ })).toBe(undefined)
  await mid.unmount()

  await $.turn.complete({ answer: '', durationMs: 3000, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: '훅 · 규칙' }))?.text).toBe('훅 · 규칙')
  expect((await ui.find({ type: 'Text', text: /^⚑ 막음/ }))?.text).toBe(`⚑ ${blocked}`)
  await ui.unmount()
  // 막음 → 덧붙인 지시 → 불러온 규칙 순
  const r = await $.command.run({ command: 'trace', args: '설명' } as never)
  expect(r.text).toContain(`- 훅 · 규칙: ${blocked}; 요청 때 지시를 덧붙임: 존댓말로 답할 것.; ${loaded}`)
})

test('훅 글은 첫 줄만: 태그 줄 · 머리표는 건너뛴다', async () => {
  expect(hookLine('<EXTREMELY_IMPORTANT>\nYou have superpowers.\nmore')).toBe('You have superpowers.')
  expect(hookLine('# 이전 세션 핸드오프\n내용')).toBe('이전 세션 핸드오프')
  expect(hookLine('\n\n')).toBe('')
})

test('이어서 하는 턴(백그라운드 알림 · 빈 글 · 같은 글 반복)은 새 작업이 아니라 진행률과 흐름을 이어 간다', async ($, on) => {
  engine(on)
  let reply = say('[2/3] 테스트를 뒤에서 돌립니다', 'u1', 'Bash')
  on('turn.step', async function* () {
    return yield* reply()
  })
  on('tool.call', () => ({ result: {}, text: '' }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '/loop 테스트 돌려줘', turnId: 't1' })
  await drain($.turn.step({ turnId: 't1', index: 0, model: 'opus', messageCount: 1 }))
  await $.tool.call({ tool: 'Bash', command: 'npm test', description: '전체 테스트 돌리기', tool_use_id: 'u1' } as never)
  await $.turn.complete({ answer: '', durationMs: 30_000, isAborted: false, turnId: 't1', reason: 'answer' } as never)

  for (const text of ['<task-notification>끝남</task-notification>', '', '/loop 테스트 돌려줘']) {
    await $.turn.start({ text, turnId: 't2' })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /^작업 \d개/ })).toBe(undefined)
    expect((await ui.find({ text: /2\/3단계 50%/ })) !== undefined).toBe(true)
    expect((await ui.find({ type: 'Text', text: /\[2\/3\]/ }))?.text).toBe('▸ [2/3] 테스트를 뒤에서 돌립니다')
    await ui.unmount()
    await $.turn.complete({ answer: '', durationMs: 10_000, isAborted: false, turnId: 't2', reason: 'answer' } as never)
  }
  // 걸린 시간은 턴들의 합: 30초 + 10초 x3
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^작업 설명/ }))?.text).toBe('작업 설명  끝남, 1분 0초')
  await ui.unmount()
})

test('작업 중에 친 요청은 지금 작업의 「추가 요청」으로 보이고, 끝난 카드의 요청 칸에도 남는다', async ($, on) => {
  engine(on)
  on('turn.step', async function* () {
    return yield* say('[1/2] 버튼 파일을 찾습니다', 'u1', 'Glob')()
  })
  on('tool.call', () => ({ result: {}, text: '' }))
  on('prompt.submit', (_, e) => ({ text: e.text }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '버튼 모서리 값 알려줘', turnId: 't1' })
  await drain($.turn.step({ turnId: 't1', index: 0, model: 'opus', messageCount: 1 }))
  await $.tool.call({ tool: 'Glob', pattern: '**/Button*', tool_use_id: 'u1' } as never)
  await $.prompt.submit({ text: '그 다음엔 높이 값도 알려줘. 고치지는 마.', turnId: 't1', wait: false, origin: { kind: 'composer' } } as never)
  // 알림 · 기다리게 보낸 글은 추가 요청이 아님
  await $.prompt.submit({ text: '<task-notification>x</task-notification>', turnId: 't1', wait: false, origin: { kind: 'task-notification' } } as never)
  await $.prompt.submit({ text: '다음 작업', turnId: 't1', wait: true, origin: { kind: 'composer' } } as never)

  const mid = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await mid.find({ type: 'Text', text: /^추가 요청/ }))?.text).toBe('추가 요청 그 다음엔 높이 값도 알려줘.')
  expect(await mid.find({ type: 'Text', text: /^작업 \d개/ })).toBe(undefined)
  expect(await mid.find({ text: /task-notification|다음 작업/ })).toBe(undefined)
  await mid.unmount()

  await $.turn.complete({ answer: '', durationMs: 5000, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^작업 중 추가/ }))?.text).toBe('작업 중 추가: 그 다음엔 높이 값도 알려줘.')
  await ui.unmount()
  const r = await $.command.run({ command: 'trace', args: '설명' } as never)
  expect(r.text).toContain('- 작업 중 추가 요청: 그 다음엔 높이 값도 알려줘. 고치지는 마.')
})

test('컴퓨터 여유: 선은 resource-guard 와 같다(디스크 2GB · 메모리 90% · 가용 2GB)', async () => {
  expect(hostLevel({ diskGB: 1.9, memPct: 50, memFreeMB: 9000 })).toBe('critical')
  expect(hostLevel({ diskGB: 20, memPct: 91, memFreeMB: 9000 })).toBe('critical')
  expect(hostLevel({ diskGB: 20, memPct: 50, memFreeMB: 1500 })).toBe('critical')
  expect(hostLevel({ diskGB: 3, memPct: 50, memFreeMB: 9000 })).toBe('warn')
  expect(hostLevel({ diskGB: 20, memPct: 50, memFreeMB: 9000 })).toBe('ok')
  expect(hostWarning({ diskGB: 1, memPct: 50, memFreeMB: 9000 })).toBe('디스크가 모자라 셸 명령이 잠시 멈춥니다')
  expect(hostWarning({ diskGB: 20, memPct: 50, memFreeMB: 9000 })).toBe(undefined)
  // 디스크를 못 쟀거나(-1) 모양이 틀리면 줄을 띄우지 않는다
  expect(parseHost('{"diskGB":-1,"memPct":1,"memFreeMB":1}')).toBe(undefined)
  expect(parseHost('x')).toBe(undefined)
  // 메모리 흐름 막대: 0 → ▁, 50 → ▅, 100 → █
  expect(spark([0, 50, 100])).toBe('▁▅█')
  expect(parseHost('{"diskGB":3.7,"memPct":61.5,"memFreeMB":9000}')).toEqual({ at: 0, diskGB: 3.7, memPct: 61.5, memFreeMB: 9000 })
})

test('컴퓨터 여유: 디스크가 2GB 아래면 뒤에서 정리하고 알리며, [ 정리하기 ] 로도 돌린다', async ($, on) => {
  const disks = [1.5, 1.5, 3.1, 3.1, 3.1, 4.2]
  const ran: string[] = []
  const toasts: string[] = []
  engine(on, {
    env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
    run: argv => {
      ran.push(String(argv[0]))
      return argv[0] === 'node'
        ? { exitCode: 0, stdout: JSON.stringify({ diskGB: disks.shift() ?? 4.2, memPct: 61.5, memFreeMB: 9000 }), stderr: '' }
        : { exitCode: 0, stdout: '', stderr: '' }
    },
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const settle = async (n: number) => {
    for (let i = 0; i < 200_000 && toasts.length < n; i++) await Promise.resolve()
  }

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await settle(1)
  // 처음 잼(1.5) → 정리 전에 다시 잼 → 정리 → 정리 뒤 잼
  expect(ran).toEqual(['node', 'node', 'powershell', 'node'])
  expect(toasts).toEqual(['디스크 자동 정리: 1.5GB → 3.1GB'])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^C 여유/ }))?.text).toMatch(
    /^C 여유 3\.1GB · 메모리 61\.5% ▅▅▅ {2}\d\d:\d\d 자동 정리 1\.5 → 3\.1GB$/,
  )
  expect(await ui.find({ type: 'Text', text: /^⚠/ })).toBe(undefined)
  // 손으로 누르면 30분 안이어도 돈다
  await ui.press({ key: 'clean' })
  await settle(2)
  expect(toasts[1]).toBe('디스크 정리: 3.1GB → 3.1GB')
  await ui.unmount()
})

test('컴퓨터 여유: 메모리가 모자라면 맨 위에 빨간 안내(정리는 디스크만)', async ($, on) => {
  const ran: string[] = []
  engine(on, {
    run: argv => {
      ran.push(String(argv[0]))
      return { exitCode: 0, stdout: JSON.stringify({ diskGB: 40, memPct: 93, memFreeMB: 1200 }), stderr: '' }
    },
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 200_000 && ran.length === 0; i++) await Promise.resolve()
  for (let i = 0; i < 2_000; i++) await Promise.resolve()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^⚠/ }))?.text).toBe(
    '⚠ 메모리가 모자라 셸 명령이 잠시 멈춥니다 — 브라우저 탭 · 개발 서버를 줄이면 풀립니다',
  )
  expect(ran).toEqual(['node'])
  await ui.unmount()
})

test('도구 앞 문장을 영어로 쓰면 그 도구 결과에 「한국어로」 안내를 한 번 붙인다', async ($, on) => {
  engine(on)
  let reply = say("I'll check whether it's live by looking for a file.", 'u1', 'Bash')
  on('turn.step', async function* () {
    return yield* reply()
  })
  on('tool.call', () => ({ result: {}, text: '' }))
  on('classic.PostToolUse', () => ({}))
  const post = (id: string) =>
    $.classic.PostToolUse({ tool_name: 'Bash', tool_input: {}, tool_response: {}, tool_use_id: id } as never)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '확인해줘', turnId: 't1' })
  await drain($.turn.step({ turnId: 't1', index: 0, model: 'opus', messageCount: 1 }))
  expect((await post('u1')).additionalContext?.at(-1)).toContain('다음 문장부터 반드시 한국어로 쓴다')
  // 한 번만
  expect((await post('u1')).additionalContext).toBe(undefined)
  // 한국어 문장 · 파일 이름만 영어인 문장은 붙이지 않는다
  reply = say('README.md 를 봅니다', 'u2', 'Bash', 1)
  await drain($.turn.step({ turnId: 't1', index: 1, model: 'opus', messageCount: 2 }))
  expect((await post('u2')).additionalContext).toBe(undefined)
  expect(isEnglish('Now the tests.')).toBe(true)
  expect(isEnglish('Now I run the tests and the type check together.')).toBe(true)
  expect(isEnglish('uv cache clean 을 돌립니다')).toBe(false)
})

test('아무 일도 없을 때 안내 문구', async $ => {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /아직 작업이 없습니다/ })) !== undefined).toBe(true)
  await ui.unmount()
})
