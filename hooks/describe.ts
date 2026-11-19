// 도구 호출을 사람이 읽는 한국어로 바꾸는 순수 함수들(엔진 호출 없음)
import type { Evidence, Group, HookAct, HookNote, Host, Item, Phase, Story } from '../types'

type Args = Record<string, unknown>

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
export const hasHangul = (s: string) => /[가-힣]/.test(s)
export const base = (p: string): string => p.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? p
// ponytail: 글자 수로 자름(한글 2칸은 화면의 truncate-end 가 마저 처리)
export const clip = (s: string, n = 40): string => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 2)}..` : t
}

const MCP: Record<string, string> = {
  figma: '피그마',
  jira: '지라',
  confluence: '위키',
  obsidian: '옵시디언',
  'claude-in-chrome': '크롬',
  claude_ai_Gmail: '지메일',
  claude_ai_Claude_Docs: '문서',
  'plugin_claude-mem_mcp-search': '기억 검색',
  headroom: '압축',
}
const AGENT: Record<string, string> = {
  Explore: '탐색 도우미',
  Plan: '설계 도우미',
  'general-purpose': '도우미',
  fork: '분신 도우미',
  'claude-code-guide': '안내 도우미',
}
export const agentName = (type: string): string => AGENT[type] ?? `${type} 도우미`

const mcpParts = (tool: string): [string, string] | undefined => {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool)
  return m ? [m[1] ?? '', m[2] ?? ''] : undefined
}
// MCP 도구 이름의 낱말(jira_add_comment → add)로 동작을 정한다
const VERBS: [RegExp, string][] = [
  [/^screenshot$/, '화면 캡처'],
  [/^navigate$/, '페이지 이동'],
  [/^(computer|form|upload_image)$/, '화면 조작'],
  [/^javascript$/, '스크립트 실행'],
  [/^tabs$/, '탭 확인'],
  [/^(delete|remove|trash)$/, '지우기'],
  [/^(create|add|upload|send|batch|update|edit|set|transition|move|label|write|commit|stage|apply|reply|forward|assign|link)$/, '쓰기'],
  [/^(search|find|query|list)$/, '찾기'],
  [/^(get|read|fetch|download|export|view)$/, '보기'],
]
const mcpVerb = (name: string): string => {
  for (const [re, verb] of VERBS) if (name.split('_').some(w => re.test(w))) return verb
  return '보기'
}
const isMcpWrite = (name: string) => ['쓰기', '지우기'].includes(mcpVerb(name))
// MCP 서버 이름(지라 서버의 confluence_* 도구는 위키)
const mcpName = (server: string, name: string): string =>
  /confluence/.test(server) || name.startsWith('confluence_') ? '위키' : (MCP[server] ?? '외부 도구')
const mcpLabel = (server: string, name: string): string => {
  const n = mcpName(server, name)
  const verb = mcpVerb(name)
  return verb === '보기'
    ? `${n}에서 확인`
    : verb === '찾기'
      ? `${n}에서 찾기`
      : verb === '쓰기'
        ? `${n}에 쓰기`
        : verb === '지우기'
          ? `${n}에서 지우기`
          : `${n} ${verb}`
}

// 읽은 파일은 이름 대신 종류로: 소스 · 스킬 문서 · AI 문서 · 지침 메모 …
export const docKind = (path: string): string => {
  const p = path.replace(/\\/g, '/')
  if (/\/memory\//.test(p)) return '지침 메모'
  if (/(^|\/)(CLAUDE|AGENTS)\.md$/i.test(p)) return '프로젝트 규칙'
  if (/\.ai\.md$|\/(specs?|decisions)\/.+\.md$/i.test(p)) return 'AI 문서'
  if (/\/skills\//i.test(p)) return '스킬 문서'
  if (/\/(plugins|mods|dev-mods)\/.+\.md$|\/\.claude\/(rules|commands|agents)\//i.test(p)) return '플러그인 문서'
  if (/\.(md|mdx|txt)$/i.test(p)) return '문서'
  if (/\.(png|jpe?g|gif|svg|webp)$/i.test(p)) return '그림'
  if (/\.(json|ya?ml|toml|ini)$|(^|\/)\.env/i.test(p)) return '설정'
  return '소스'
}
const GUIDE_KINDS = ['지침 메모', '프로젝트 규칙', 'AI 문서', '스킬 문서', '플러그인 문서']
const stemOf = (path: string) => base(path).replace(/(\.ai)?\.(mdx?|txt)$/i, '')
const skillOf = (path: string) => /\/skills\/([^/]+)\//.exec(path.replace(/\\/g, '/'))?.[1]
// 한글 이름(점검 · 디자인-반영)만 보여 주고, 영어 파일 이름은 종류만
const named = (path: string) => {
  const kind = docKind(path)
  const stem = stemOf(path)
  return hasHangul(stem) ? `${kind} 「${stem}」` : kind
}

// 셸 명령 → 한국어(첫 일치)
const SHELL: [RegExp, string][] = [
  [/\bgit (log|blame)\b/, '변경 이력 보기'],
  [/\bgit show\b/, '커밋 내용 보기'],
  [/\bgit diff\b/, '바뀐 내용 비교'],
  [/\bgit status\b/, '작업 상태 확인'],
  [/\bgit commit\b/, '커밋하기'],
  [/\bgit push\b/, '원격에 올리기'],
  [/\bgit (merge|rebase|cherry-pick)\b/, '브랜치 합치기'],
  [/\bgit (checkout|switch|branch|worktree)\b/, '브랜치 다루기'],
  [/\bclaude plugin test\b|\b(vitest|jest|pytest)\b|\b(npm|pnpm|yarn)( run)? test\b/, '테스트 돌리기'],
  [/\bclaude plugin validate\b/, 'mod 검사'],
  [/\btsc\b/, '타입 검사'],
  [/\b(eslint|lint)\b/, '코드 규칙 검사'],
  [/\bplaywright\b/, '화면 자동 확인'],
  [/\b(build)\b/, '빌드'],
  [/\b(npm|pnpm|yarn) (i|install|add)\b/, '패키지 설치'],
  [/\b(curl|wget|Invoke-WebRequest|irm|iwr)\b/, '웹에서 받기'],
  [/\b(rm|Remove-Item)\b/, '파일 지우기'],
  [/\b(cp|mv|Copy-Item|Move-Item)\b/, '파일 옮기기'],
  [/\b(mkdir|New-Item)\b/, '폴더 만들기'],
  [/\b(grep|rg|Select-String)\b/, '내용 찾기'],
  [/\b(cat|head|tail|less|Get-Content)\b|\bsed -n\b/, '파일 내용 보기'],
  [/\b(ls|find|dir|tree|Get-ChildItem)\b/, '폴더 살펴보기'],
]
const shellLabel = (cmd: string, description: string): string => {
  if (hasHangul(description)) return clip(description, 70)
  for (const [re, label] of SHELL) if (re.test(cmd)) return label
  return '명령 실행'
}

const lines = (s: string) => (s === '' ? 0 : s.split('\n').length)

/** 도구 호출 → 「Button.tsx 읽기」 같은 한국어 동작 이름 */
export const labelOf = (tool: string, a: Args): string => {
  const path = str(a.file_path) || str(a.notebook_path)
  switch (tool) {
    case 'Read':
      return `${named(path)} 확인`
    case 'Edit':
      return `${named(path)} 고치기 +${lines(str(a.new_string))} -${lines(str(a.old_string))}`
    case 'Write':
      return `${named(path)} 새로 쓰기`
    case 'NotebookEdit':
      return `${named(path)} 고치기`
    case 'Grep': {
      // 정규식은 사람이 읽기 어려우니 낱말일 때만 보여 준다
      const p = str(a.pattern)
      return /^[\p{L}\p{N}_ .-]{1,30}$/u.test(p) ? `「${p}」 찾기` : '코드에서 찾기'
    }
    case 'Glob':
      return '파일 찾기'
    case 'Bash':
    case 'PowerShell':
      return shellLabel(str(a.command), str(a.description))
    case 'WebSearch':
      return `웹 검색 「${clip(str(a.query), 24)}」`
    case 'WebFetch':
      return '웹 페이지 확인'
    case 'Skill':
      return `「${str(a.skill)}」 스킬 불러오기`
    case 'Agent':
      return `${agentName(str(a.subagent_type) || 'general-purpose')}에게 맡김: ${clip(str(a.description), 24)}`
    case 'AskUserQuestion':
      return '사용자에게 질문'
    case 'ToolSearch':
      return '도구 불러오기'
    case 'Artifact':
      return '보고서 페이지 다루기'
    case 'ScheduleWakeup':
      return a.stop === true ? '반복 끝내기' : `${Math.round(Number(a.delaySeconds ?? 0) / 60)}분 뒤 다시 진행 예약`
    case 'Monitor':
      return `감시 걸기 ${clip(str(a.description), 24)}`.trim()
    case 'TaskStop':
      return '백그라운드 작업 멈추기'
    case 'SendMessage':
      return '도우미에게 메시지'
    case 'PushNotification':
      return '알림 보내기'
    case 'Workflow':
      return '여러 도우미 작업 흐름 실행'
    case 'CronCreate':
      return '정기 작업 예약'
  }
  const mcp = mcpParts(tool)
  if (mcp) return mcpLabel(mcp[0], mcp[1])
  return tool
}

/** 펼친 화면에서 흐리게 덧붙이는 대상(파일 이름) */
export const targetOf = (tool: string, a: Args): string | undefined => {
  const path = str(a.file_path) || str(a.notebook_path)
  return path !== '' && ['Read', 'Edit', 'Write', 'NotebookEdit'].includes(tool) ? base(path) : undefined
}

/** 동작의 종류(개수 셀 때): 소스 · 지침 메모 · 위키 · 변경 이력 · 검색 · 명령 · 고침 … ('' = 안 셈) */
export const sourceOf = (tool: string, a: Args): string => {
  if (tool === 'Read') return docKind(str(a.file_path))
  if (['Edit', 'Write', 'NotebookEdit'].includes(tool)) return '고침'
  if (tool === 'Grep' || tool === 'Glob') return '검색'
  if (tool === 'Bash' || tool === 'PowerShell') {
    const cmd = str(a.command)
    return /\bgit (log|show|blame|diff)\b/.test(cmd) ? '변경 이력' : VERIFY.test(cmd) ? '검사' : '명령'
  }
  if (tool === 'WebSearch' || tool === 'WebFetch') return '웹'
  if (tool === 'Skill') return '스킬'
  if (tool === 'Agent') return '도우미'
  const mcp = mcpParts(tool)
  return mcp ? mcpName(mcp[0], mcp[1]) : ''
}

const VERIFY = /\bclaude plugin (test|validate)\b|\b(vitest|jest|pytest|tsc|eslint|lint|playwright|build)\b|\b(npm|pnpm|yarn)( run)? test\b/
const CHANGE = /\bgit (commit|push|merge|rebase|cherry-pick)\b|\b(rm|mv|cp|mkdir|Remove-Item|Move-Item|Copy-Item|New-Item)\b/

/** 조사 · 근거 · 변경 · 검증 */
export const phaseOf = (tool: string, a: Args): Phase => {
  const path = str(a.file_path).replace(/\\/g, '/')
  if (tool === 'Skill') return 'guide'
  if (tool === 'Read') return GUIDE_KINDS.includes(docKind(path)) ? 'guide' : 'explore'
  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') return 'change'
  if (tool === 'Bash' || tool === 'PowerShell') {
    const cmd = str(a.command)
    return VERIFY.test(cmd) ? 'verify' : CHANGE.test(cmd) ? 'change' : 'explore'
  }
  const mcp = mcpParts(tool)
  if (mcp) {
    if (mcp[0] === 'claude-in-chrome') return 'verify'
    if (isMcpWrite(mcp[1])) return 'change'
    return mcpName(mcp[0], mcp[1]) !== '외부 도구' ? 'guide' : 'explore'
  }
  return 'explore'
}

/** 메모 목차(MEMORY.md)의 「[디자인 우선순위](feedback_design_priority.md)」에서 한글 제목 */
export const memoTitle = (index: string, path: string): string | undefined => {
  const file = base(path)
  for (const m of index.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
    const title = (m[1] ?? '').replace(/\s*\([^)]*\d{4}[^)]*\)\s*$/, '').trim()
    if (base(m[2] ?? '') === file && hasHangul(title)) return title
  }
  return undefined
}

/** 도구 호출 하나에서 뽑는 근거. memoIndex = 읽은 메모가 있는 폴더의 MEMORY.md */
export const evidenceOf = (tool: string, a: Args, text: string, group: number, memoIndex = ''): Evidence[] => {
  const out: Evidence[] = []
  // 작업 번호는 부르는 쪽이 채운다
  const add = (kind: Evidence['kind'], t: string) => out.push({ kind, text: t, task: 0, group, count: 1 })
  const path = str(a.file_path)
  if (tool === 'Read' && path !== '') {
    const kind = docKind(path)
    const skill = skillOf(path)
    const stem = stemOf(path)
    if (skill !== undefined) add('skill', skill)
    if (kind === '지침 메모') {
      const title = memoTitle(memoIndex, path)
      if (title !== undefined) add('guide', title)
    } else if (kind === '프로젝트 규칙') add('guide', '프로젝트 규칙')
    else if (GUIDE_KINDS.includes(kind) && !/^SKILL$/i.test(stem) && hasHangul(stem)) {
      add('guide', skill !== undefined ? `${stem} (${skill} 스킬)` : stem)
    }
  }
  if (tool === 'Skill' && str(a.skill) !== '') add('skill', str(a.skill))
  if ((tool === 'Bash' || tool === 'PowerShell') && /\bgit (log|show)\b/.test(str(a.command))) {
    const found = [
      ...text.matchAll(/^([0-9a-f]{7,40}) (.+)$/gm),
      ...text.matchAll(/^commit ([0-9a-f]{7,40})[\s\S]*?\n\n\s+(.+)/gm),
    ]
    // 제목만: 날짜 · 시각 · 작성자 머리는 떼고, 병합 커밋은 근거가 아니므로 뺀다
    const subject = (s: string) =>
      s
        .replace(/^\d{4}-\d{2}-\d{2}(\s+\d{2}:\d{2}(:\d{2})?(\s+[+-]\d{4})?)?\s*/, '')
        .replace(/^[^|]{1,20}\|\s*/, '')
        .trim()
    const picked = found
      .map(m => ({ hash: (m[1] ?? '').slice(0, 8), title: subject(m[2] ?? '') }))
      .filter(c => c.title !== '' && !/^Merge (branch|pull request|remote)/.test(c.title))
      .slice(0, 3)
    for (const c of picked) add('commit', `${c.hash} ${clip(c.title, 120)}`)
  }
  const mcp = mcpParts(tool)
  if (mcp) {
    const node = str(a.nodeId) || str(a.node_id)
    const key = str(a.issue_key) || str(a.issueKey)
    const page = str(a.page_id) || str(a.pageId)
    if (mcp[0] === 'figma' && node !== '') add('external', `피그마 노드 ${node}`)
    if (key !== '') add('external', `지라 ${key}`)
    if (page !== '') add('external', `위키 ${page}`)
    if (mcp[0] === 'obsidian' && str(a.path) !== '') add('external', `옵시디언 ${base(str(a.path))}`)
  }
  return out
}

/** 같은 근거는 합치고 횟수를 센다 */
export const mergeEvidence = (list: readonly Evidence[], items: readonly Evidence[]): Evidence[] => {
  const next = [...list]
  for (const it of items) {
    const i = next.findIndex(x => x.kind === it.kind && x.text === it.text && x.task === it.task)
    const old = next[i]
    if (old !== undefined) next[i] = { ...old, count: old.count + 1 }
    else next.push(it)
  }
  return next.slice(-150)
}

const STEP = /\[(\d+)\/(\d+)\]/g
const GUIDE = /\(지침:\s*([^)]+)\)/g

/** 도구 앞 문장에서 묶음 제목 · 단계 표시 · 지침을 꺼낸다 */
export const parseNarration = (text: string): { title: string; step?: { n: number; m: number }; guides: string[] } => {
  const guides = [...text.matchAll(GUIDE)].flatMap(m => (m[1] ?? '').split(/[,·]/).map(s => s.trim()).filter(Boolean))
  const steps = [...text.matchAll(STEP)]
  const last = steps[steps.length - 1]
  const step = last ? { n: Number(last[1]), m: Number(last[2]) } : undefined
  const line =
    text
      .split('\n')
      .map(l => l.trim())
      // 글자 없는 줄(설명 상자 테두리 `─────`)은 제목이 아니다
      .filter(l => /[\p{L}\p{N}]/u.test(l) && !l.startsWith('|') && !l.startsWith('```'))
      .pop() ?? ''
  const title = clip(
    line
      .replace(GUIDE, '')
      .replace(STEP, '')
      .replace(/[*`#>]/g, '')
      // 목록 머리(「1. 」「- 」)만 뗀다. 「6이라는」 같은 첫 숫자는 남김
      .trim()
      .replace(/^(?:[-*]\s+|\d+[.)]\s+)/, '')
      // 첫 문장만: 좁은 패널에서 한 줄로 읽히게(「README.md를」 같은 점은 뒤에 빈칸이 없어 안 끊김)
      .replace(/([.!?])\s.*$/, '$1'),
    140,
  )
  return step ? { title, step, guides } : { title, guides }
}

export const groupLabel = (g: Pick<Group, 'n' | 'step'>): string => (g.step ? `[${g.step.n}/${g.step.m}]` : `(${g.n})`)

// resource-guard 와 같은 선: 이 아래로 내려가면 셸 · 도우미 호출이 멈춘다
export const DISK_MIN_GB = 2
const MEM_MAX_PCT = 90
const MEM_MIN_FREE_MB = 2048
export type HostLevel = 'ok' | 'warn' | 'critical'
type HostNums = Pick<Host, 'diskGB' | 'memPct' | 'memFreeMB'>
const diskLow = (h: HostNums) => h.diskGB < DISK_MIN_GB
const memLow = (h: HostNums) => h.memPct > MEM_MAX_PCT || h.memFreeMB < MEM_MIN_FREE_MB
/** 멈춤(빨강) · 곧 멈춤(노랑: 디스크 5GB 아래 · 메모리 80% 넘음) · 괜찮음 */
export const hostLevel = (h: HostNums): HostLevel =>
  diskLow(h) || memLow(h) ? 'critical' : h.diskGB < 5 || h.memPct > 80 ? 'warn' : 'ok'
/** 0~100 값들 → 「▁▃▅█」 같은 한 줄 막대(블록 글자라 어느 화면에서나 보임) */
const BARS = '▁▂▃▄▅▆▇█'
export const spark = (values: readonly number[]): string =>
  values.map(v => BARS[Math.max(0, Math.min(7, Math.floor((v / 100) * 8)))] ?? '').join('')

/** 모자랄 때의 안내 한 줄(어느 PC 에서나 맞는 말로 — 명령이 멈추는지는 그 PC 의 설정에 달림) */
export const hostWarning = (h: HostNums): string | undefined => {
  const d = diskLow(h)
  const m = memLow(h)
  if (!d && !m) return undefined
  const what = [d ? '디스크' : '', m ? '메모리' : ''].filter(Boolean).join(' · ')
  const why = [d ? '2GB 아래' : '', m ? '90% 넘음 · 가용 2GB 아래' : ''].filter(Boolean).join(' · ')
  return `${what}가 모자랍니다(${why})${m ? ' — 브라우저 탭 · 개발 서버를 줄여 보세요' : ''}`
}
/** 잰 값 · host.json 글 → Host. 모양이 틀리거나 디스크를 못 쟀으면 undefined */
export const parseHost = (s: string): Host | undefined => {
  try {
    const j = JSON.parse(s) as Record<string, unknown>
    const num = (k: string) => (typeof j[k] === 'number' ? (j[k] as number) : undefined)
    const [diskGB, memPct, memFreeMB, cleanAt] = [num('diskGB'), num('memPct'), num('memFreeMB'), num('cleanAt')]
    if (diskGB === undefined || diskGB < 0 || memPct === undefined || memFreeMB === undefined) return undefined
    return { at: num('at') ?? 0, diskGB, memPct, memFreeMB, ...(cleanAt !== undefined ? { cleanAt } : {}) }
  } catch {
    return undefined
  }
}

export const hhmm = (ms: number) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
export const ymd = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const or = (list: readonly string[]) => (list.length === 0 ? '없음' : list.join(', '))

// 줄바꿈 계산: 한글 · 한자는 2칸
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/
export const cells = (s: string): number => {
  let n = 0
  for (const ch of s) n += WIDE.test(ch) ? 2 : 1
  return n
}
export const linesOf = (s: string, width: number): number => Math.max(1, Math.ceil(cells(s) / Math.max(10, width)))

// 동작을 파일 이름 대신 종류별 개수로: 「지침 메모 2개」「소스 5개」「검색 2번」
const SOURCE_ORDER = [
  '지침 메모', '프로젝트 규칙', '스킬', '스킬 문서', 'AI 문서', '플러그인 문서', '문서',
  '위키', '지라', '피그마', '옵시디언', '웹', '변경 이력',
  '소스', '설정', '그림', '검색', '명령', '고침', '검사', '크롬', '도우미',
]
const UNIT: Record<string, (n: number) => string> = {
  고침: n => `${n}곳 고침`,
  도우미: n => `도우미 ${n}명`,
  스킬: n => `스킬 ${n}개`,
}
const FILE_KINDS = ['지침 메모', '프로젝트 규칙', '스킬 문서', 'AI 문서', '플러그인 문서', '문서', '소스', '설정', '그림']
export const countActions = (sources: readonly string[]): string[] => {
  const count = new Map<string, number>()
  for (const k of sources) if (k !== '') count.set(k, (count.get(k) ?? 0) + 1)
  const rank = (k: string) => (SOURCE_ORDER.includes(k) ? SOURCE_ORDER.indexOf(k) : SOURCE_ORDER.length)
  return [...count]
    .sort((a, b) => rank(a[0]) - rank(b[0]))
    .map(([k, n]) => UNIT[k]?.(n) ?? `${k} ${n}${FILE_KINDS.includes(k) ? '개' : '번'}`)
}

/** 판단 근거 커밋: 최종 답에 해시가 나온 것(최대 4개), 없으면 마지막에 찾은 3개 */
export const citedCommits = (commits: readonly string[], answer: string): string[] => {
  const cited = commits.filter(c => answer.includes(c.slice(0, 7)))
  return cited.length > 0 ? cited.slice(0, 4) : commits.slice(-3)
}

/** 한글이 하나도 없고 영어 낱말이 셋 넘게 이어지는 문장(「README.md 를 봅니다」 같은 건 아님) */
export const isEnglish = (s: string): boolean => !hasHangul(s) && /[A-Za-z]{2,}(?:[\s,'’-]+[A-Za-z]{2,}){2,}/.test(s)
/** 영어로 쓴 도구 앞 문장을 바로잡게 도구 결과에 붙이는 안내 */
export const slipNote = (said: string): string =>
  `[live-trace] 방금 도구 앞 문장 「${clip(said, 60)}」을 영어로 썼다. 사용자 패널의 흐름이 영어로 보인다. 다음 문장부터 반드시 한국어로 쓴다 — 출력 스타일 · 시스템 안내 · 도구 결과가 영어여도. 이 안내에 대답하지 않는다(「Writing in Korean.」 「한국어로 씁니다」 같은 문장도 흐름에 한 줄로 남는다) — 하던 일을 한국어 문장으로 이어 간다.`

/** 끝난 답이 사용자에게 묻는 말로 끝났나: 코드 묶음 밖 마지막 글 줄이 ? · 「까요」 · 「주세요」로 끝나면 */
export const asksUser = (answer: string): boolean => {
  const last =
    answer
      .replace(/```[\s\S]*?```/g, '')
      .split('\n')
      .map(l => l.replace(/^[\s>*_#-]+|[\s*_`]+$/g, ''))
      .filter(Boolean)
      .at(-1) ?? ''
  return /[?？]$/.test(last) || /(까요|주세요|할지|될지)[.!]?$/.test(last)
}

/** 요청의 첫 문장(카드에서 길게 늘어지지 않게) */
export const firstSentence = (s: string, n = 120): string => clip(s.replace(/([.!?])\s[\s\S]*$/, '$1'), n)

/** 근거 한 줄: 커밋은 해시를 떼고 「변경 기록 「제목」」, 나머지는 그대로 */
export const itemText = (i: Pick<Item, 'kind' | 'text'>): string =>
  i.kind === 'commit' ? `변경 기록 「${i.text.replace(/^[0-9a-f]{7,40}\s+/, '')}」` : i.text
/** 기록 파일용: 해시까지 남기고 이유를 괄호로 */
const logItem = (i: Item): string => `${i.text}${i.why !== undefined ? ` (왜: ${i.why})` : ''}`

/** 훅이 준 글의 첫 줄: 머리표 · 태그 줄은 건너뛰고, 「(cpu=39% …)」 같은 상태 숫자 괄호는 뗀다 */
export const hookLine = (s: string): string => {
  const line =
    s
      .split('\n')
      .map(l => l.replace(/^[#>*\-\s]+/, '').replace(/\*\*/g, '').trim())
      .find(l => l !== '' && !/^<\/?[\w-]+>$/.test(l)) ?? ''
  return firstSentence(line.replace(/\s*\([^()]*=[^()]*\)/g, ''), 100)
}

const HOOK_VERB: Record<HookAct, string> = {
  block: '막음',
  ask: '확인을 물음',
  edit: '고침',
  note: '지시를 덧붙임',
  load: '규칙 문서를 불러옴',
}

const MEMORY_TYPE: Record<string, string> = { User: '사용자 전체', Project: '프로젝트', Local: '이 PC 전용', Managed: '조직' }
const LOAD_REASON: Record<string, string> = {
  session_start: '세션 시작',
  nested_traversal: '하위 폴더 진입',
  path_glob_match: '경로 규칙 일치',
  include: '다른 규칙이 포함',
  compact: '대화 압축 뒤',
}
/** 불러온 규칙 문서: 「CLAUDE.md (프로젝트 · 세션 시작)」 */
export const loadedText = (path: string, type: string, reason: string): string =>
  `${base(path)} (${[MEMORY_TYPE[type] ?? type, LOAD_REASON[reason] ?? reason].join(' · ')})`
/** 「요청 때 지시를 덧붙임: 존댓말로 답할 것」 · 「막음: resource-guard: … (2번)」 */
export const hookLabel = (h: Pick<HookNote, 'act' | 'text' | 'count'> & { at?: string }): string =>
  `${h.at !== undefined ? `${h.at} 때 ` : ''}${HOOK_VERB[h.act]}: ${h.text}${h.count > 1 ? ` (${h.count}번)` : ''}`

/** 훅 결과(막음 · 덧붙인 지시) → 적을 일들 */
export const hookNotes = (
  r: { block?: string; additionalContext?: readonly string[] },
  where: Pick<HookNote, 'task' | 'group'> & { at?: string },
): Omit<HookNote, 'count'>[] =>
  [
    ...(r.block !== undefined ? [{ ...where, act: 'block' as const, text: hookLine(r.block) }] : []),
    ...(r.additionalContext ?? []).map(c => ({ ...where, act: 'note' as const, text: hookLine(c) })),
  ].filter(h => h.text !== '')

export const duration = (ms: number): string =>
  ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}초` : `${Math.floor(ms / 60_000)}분 ${Math.round((ms % 60_000) / 1000)}초`

/** 날짜별 기록: 같은 작업(key)의 절이 있으면 바꾸고, 없으면 끝에 붙인다(이어서 한 턴이 절을 겹쳐 쓰지 않게) */
export const upsertLog = (old: string, key: string, story: string): string => {
  const mark = `<!-- live-trace:${key} -->`
  const block = `${mark}\n${story}\n`
  const i = old.indexOf(mark)
  if (i < 0) return `${old.trimEnd()}\n\n${block}`
  const end = old.indexOf('<!-- live-trace:', i + mark.length)
  return `${old.slice(0, i)}${block}${end < 0 ? '' : `\n${old.slice(end)}`}`
}

/** /trace 설명 과 날짜별 기록에 쓰는 글 */
export const storyText = (s: Story): string =>
  [
    `### ${hhmm(s.at)} ${s.where ? `[${s.where}] ` : ''}${clip(s.request, 60) || '(이어서 한 작업)'}`,
    `- 상황: ${s.request || '(이어서 한 작업)'}`,
    ...(s.asks ?? []).map(a => `- 작업 중 추가 요청: ${a}`),
    `- 쓴 스킬: ${or(s.skills.map(logItem))}`,
    `- 따른 지침: ${or(s.guides.map(logItem))}`,
    ...(s.hooks.length > 0 ? [`- 훅 · 규칙: ${s.hooks.map(hookLabel).join('; ')}`] : []),
    `- 근거: ${or(s.basis.map(logItem))}`,
    `- 확인한 것: ${s.explored || '없음'}${s.ms !== undefined ? ` (걸린 시간 ${duration(s.ms)})` : ''}`,
    '- 한 일:',
    ...(s.steps.length === 0 ? ['  (기록 없음)'] : s.steps.map((t, i) => `  ${i + 1}. ${t}`)),
    `- 검증: ${s.unverified ? '바꾼 뒤 검증하지 않음' : or(s.checks)}`,
  ].join('\n')
