// Performance report from the crew service's own log: npm run report [-- --since "2026-10-29"]
// Run on the Dell: reads journalctl -u crew. Answer times by lane, voice times, model turns,
// errors, and the app's events (time from your words to Crew speaking, reconnects, voice failures).
import { execFileSync } from 'node:child_process'

export function report(lines: string[]): string {
  const series = new Map<string, number[]>()
  const counts = new Map<string, number>()
  const add = (k: string, ms: number) => { const a = series.get(k) ?? []; a.push(ms); series.set(k, a) }
  const count = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1)
  for (const l of lines) {
    let m
    if ((m = /ask answered in (\d+) ms \((\w+)/.exec(l))) add(`answer (${m[2]!})`, +m[1]!)
    else if ((m = /speak \d+ chars -> \d+ bytes in (\d+) ms/.exec(l))) add('voice made', +m[1]!)
    else if ((m = /model (\w+) turn in (\d+) ms/.exec(l))) add(`model turn (${m[1]})`, +m[2]!)
    else if ((m = /app (\w+)(?: (\d+) ms)?/.exec(l))) m[2] ? add(`app ${m[1]}`, +m[2]!) : count(`app ${m[1]}`)
    if (/Something went wrong|error|Error|403|429|failed/.test(l) && !/^.*app /.test(l)) count('errors in log')
  }
  const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))] ?? 0
  const out = ['| what | count | median | p90 | worst |', '|---|---|---|---|---|']
  for (const [k, a] of [...series].sort()) out.push(`| ${k} | ${a.length} | ${(pct(a, 0.5) / 1000).toFixed(1)} s | ${(pct(a, 0.9) / 1000).toFixed(1)} s | ${(Math.max(...a) / 1000).toFixed(1)} s |`)
  for (const [k, n] of [...counts].sort()) out.push(`| ${k} | ${n} | | | |`)
  return out.join('\n')
}

if (process.argv[1]?.endsWith('report.ts')) {
  const i = process.argv.indexOf('--since')
  const since = (i > 0 ? process.argv[i + 1] : undefined) ?? "today"
  const log = execFileSync('journalctl', ['-u', 'crew', '--since', since, '--no-pager', '-o', 'cat'], { encoding: 'utf8', maxBuffer: 64 << 20 })
  console.log(`Crew performance since ${since}\n\n${report(log.split('\n'))}`)
}
