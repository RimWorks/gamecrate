import { describe, expect, test } from 'bun:test'

import { installedItems, parseAcf } from '../src/mods/acf'

// Tabs are what Steam actually writes, so `\t` here is deliberate.
const SAMPLE = `"AppWorkshop"
{
\t"appid"\t\t"294100"
\t"WorkshopItemsInstalled"
\t{
\t\t"818773962"
\t\t{
\t\t\t"size"\t\t"2463770"
\t\t\t"timeupdated"\t\t"1752434318"
\t\t\t"manifest"\t\t"1025052661578487222"
\t\t}
\t}
\t"WorkshopItemDetails"
\t{
\t\t"818773962"
\t\t{
\t\t\t"manifest"\t\t"1025052661578487222"
\t\t\t"timeupdated"\t\t"1752434318"
\t\t\t"timetouched"\t\t"1789948957"
\t\t\t"latest_timeupdated"\t\t"1752434318"
\t\t\t"latest_manifest"\t\t"1025052661578487222"
\t\t}
\t}
}
`

const TWO_ITEMS = `"AppWorkshop"
{
\t"appid"\t\t"294100"
\t"WorkshopItemsInstalled"
\t{
\t\t"818773962"
\t\t{
\t\t\t"size"\t\t"2463770"
\t\t\t"timeupdated"\t\t"1752434318"
\t\t\t"manifest"\t\t"1025052661578487222"
\t\t}
\t\t"2009463077"
\t\t{
\t\t\t"size"\t\t"11005"
\t\t\t"timeupdated"\t\t"1699023094"
\t\t\t"manifest"\t\t"7017455373945780161"
\t\t}
\t}
}
`

describe('parseAcf', () => {
  test('reads the real sample, nesting and all', () => {
    expect(parseAcf(SAMPLE)).toEqual({
      AppWorkshop: {
        appid: '294100',
        WorkshopItemsInstalled: {
          '818773962': { size: '2463770', timeupdated: '1752434318', manifest: '1025052661578487222' },
        },
        WorkshopItemDetails: {
          '818773962': {
            manifest: '1025052661578487222',
            timeupdated: '1752434318',
            timetouched: '1789948957',
            latest_timeupdated: '1752434318',
            latest_manifest: '1025052661578487222',
          },
        },
      },
    })
  })

  test('an empty file is an empty object', () => {
    expect(parseAcf('')).toEqual({})
    expect(parseAcf('   \n\t\n')).toEqual({})
  })

  test('an unterminated brace is an empty object, not a throw', () => {
    expect(parseAcf('"AppWorkshop"\n{\n\t"appid"\t"294100"\n')).toEqual({})
  })

  test('an unterminated quote is an empty object, not a throw', () => {
    expect(parseAcf('"AppWorkshop"\n{\n\t"appid"\t"294100\n}\n')).toEqual({})
    expect(parseAcf('"AppWork')).toEqual({})
  })

  test('a stray closing brace is malformed', () => {
    expect(parseAcf('}')).toEqual({})
    expect(parseAcf('"a"\n{\n}\n}\n')).toEqual({})
  })

  test('an unquoted token is malformed', () => {
    expect(parseAcf('AppWorkshop\n{\n}\n')).toEqual({})
  })

  test('skips // comment lines, including one with no trailing newline', () => {
    const text = `// written by Steam
"AppWorkshop"
{
\t// the app this file belongs to
\t"appid"\t\t"294100"
}
// end`
    expect(parseAcf(text)).toEqual({ AppWorkshop: { appid: '294100' } })
  })

  test('unescapes backslash and quote inside a value', () => {
    expect(parseAcf('"path"\t"C:\\\\Steam\\\\steamapps"')).toEqual({ path: 'C:\\Steam\\steamapps' })
    expect(parseAcf('"name"\t"a \\"quoted\\" mod"')).toEqual({ name: 'a "quoted" mod' })
  })

  test('a comment marker inside a quoted value is not a comment', () => {
    expect(parseAcf('"url"\t"https://example.invalid/x"')).toEqual({ url: 'https://example.invalid/x' })
  })
})

describe('installedItems', () => {
  test('returns every id with its exact manifest string', () => {
    const got = installedItems(TWO_ITEMS)
    expect([...got.keys()]).toEqual(['818773962', '2009463077'])
    expect(got.get('818773962')).toEqual({ manifest: '1025052661578487222', timeupdated: 1752434318 })
    expect(got.get('2009463077')).toEqual({ manifest: '7017455373945780161', timeupdated: 1699023094 })
  })

  test('manifest ids survive past Number.MAX_SAFE_INTEGER', () => {
    const manifest = installedItems(SAMPLE).get('818773962')!.manifest
    expect(manifest).toBe('1025052661578487222')
    expect(Number(manifest)).toBeGreaterThan(Number.MAX_SAFE_INTEGER)
    expect(String(Number(manifest))).not.toBe(manifest)
  })

  test('a missing WorkshopItemsInstalled is an empty map', () => {
    const text = `"AppWorkshop"
{
\t"appid"\t\t"294100"
\t"WorkshopItemDetails"
\t{
\t\t"818773962"
\t\t{
\t\t\t"manifest"\t\t"1025052661578487222"
\t\t}
\t}
}
`
    expect(installedItems(text).size).toBe(0)
  })

  test('an empty or malformed file is an empty map', () => {
    expect(installedItems('').size).toBe(0)
    expect(installedItems('"AppWorkshop"\n{\n').size).toBe(0)
  })

  test('an entry with no manifest is skipped, its siblings are not', () => {
    const text = `"AppWorkshop"
{
\t"WorkshopItemsInstalled"
\t{
\t\t"111"
\t\t{
\t\t\t"size"\t\t"10"
\t\t\t"timeupdated"\t\t"1752434318"
\t\t}
\t\t"222"
\t\t{
\t\t\t"manifest"\t\t"999888777666555444"
\t\t\t"timeupdated"\t\t"1752434319"
\t\t}
\t}
}
`
    const got = installedItems(text)
    expect([...got.keys()]).toEqual(['222'])
    expect(got.get('222')!.manifest).toBe('999888777666555444')
  })

  test('an entry with no timeupdated reads as 0', () => {
    const text = '"WorkshopItemsInstalled"\n{\n\t"333"\n\t{\n\t\t"manifest"\t"1"\n\t}\n}\n'
    expect(installedItems(text).get('333')).toEqual({ manifest: '1', timeupdated: 0 })
  })
})
