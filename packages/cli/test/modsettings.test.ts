import { describe, expect, test } from 'bun:test'
import { renderModSettings } from '../../rimworld/src/xml'
import type { ModSettingsFile } from '../src/types'

const block: ModSettingsFile = {
  file: 'Mod_RimWorks.RimLogging_LoggingMod.xml',
  class: 'RimWorks.RimLogging.Settings.LoggingSettings',
  values: { sinkOverrideNames: ['RollingJson'], sinkOverrideStates: [true] },
}

const forced: ModSettingsFile = { ...block, replace: ['sinkOverrideNames', 'sinkOverrideStates'] }

const real = `﻿<?xml version="1.0" encoding="utf-8"?>
<SettingsBlock>
\t<ModSettings Class="RimWorks.RimLogging.Settings.LoggingSettings">
\t\t<logDirectory>/tmp/x</logDirectory>
\t\t<filterPresetNames />
\t</ModSettings>
</SettingsBlock>`

describe('mergeModSettings', () => {
  test('adds what is missing and keeps what is there', () => {
    const out = renderModSettings(real, block)
    expect(out).toContain('<logDirectory>/tmp/x</logDirectory>')
    expect(out).toContain('<li>RollingJson</li>')
    expect(out).toContain('</SettingsBlock>')
  })

  test('a value already set is never overwritten', () => {
    const chosen = real.replace(
      '<filterPresetNames />',
      '<sinkOverrideNames><li>RollingJson</li></sinkOverrideNames>\n\t\t<sinkOverrideStates><li>False</li></sinkOverrideStates>',
    )
    expect(renderModSettings(chosen, block)).toBe(chosen)
  })

  test('a file with every key already set is returned unchanged', () => {
    const once = renderModSettings(real, block)
    expect(renderModSettings(once, block)).toBe(once)
  })

  test('a missing file is created with the class the block names', () => {
    const out = renderModSettings(null, block)
    expect(out).toContain('Class="RimWorks.RimLogging.Settings.LoggingSettings"')
    expect(out).toContain('<li>RollingJson</li>')
  })

  test('a bool renders the way the engine writes one', () => {
    expect(renderModSettings(null, { ...block, values: { a: true, b: false } })).toContain('<a>True</a>')
    expect(renderModSettings(null, { ...block, values: { a: true, b: false } })).toContain('<b>False</b>')
  })

  test('an empty list is a self-closing tag, not an empty pair', () => {
    expect(renderModSettings(null, { ...block, values: { names: [] } })).toContain('<names />')
  })

  test('markup in a value cannot break the document', () => {
    const out = renderModSettings(null, { ...block, values: { note: '<b>&x</b>' } })
    expect(out).toContain('&lt;b&gt;&amp;x&lt;/b&gt;')
  })

  test('a file with no closing block is left alone rather than corrupted', () => {
    expect(renderModSettings('not xml at all', block)).toBe('not xml at all')
  })

  test('a key that is a prefix of another is not mistaken for it', () => {
    const withLonger = real.replace('<filterPresetNames />', '<sinkOverrideNamesExtra>x</sinkOverrideNamesExtra>')
    expect(renderModSettings(withLonger, block)).toContain('<sinkOverrideNames>')
  })

  test('a replace key wins over a value the file already sets', () => {
    const off = real.replace(
      '<filterPresetNames />',
      '<sinkOverrideNames><li>RollingJson</li></sinkOverrideNames>\n\t\t<sinkOverrideStates><li>False</li></sinkOverrideStates>',
    )
    const out = renderModSettings(off, forced)
    expect(out).toContain('<li>True</li>')
    expect(out).not.toContain('<li>False</li>')
    expect(out.match(/<sinkOverrideStates[ >]/g)).toHaveLength(1)
    expect(out).toContain('<logDirectory>/tmp/x</logDirectory>')
  })

  test('a replace key wins over a tag whose attribute value holds a slash', () => {
    const attr = real.replace(
      '<filterPresetNames />',
      '<sinkOverrideNames path="a/b"><li>Old</li></sinkOverrideNames>\n\t\t<sinkOverrideStates />',
    )
    const out = renderModSettings(attr, forced)
    expect(out).toContain('<li>RollingJson</li>')
    expect(out).not.toContain('<li>Old</li>')
    expect(out).not.toContain('path="a/b"')
    expect(out.match(/<sinkOverrideNames[ >]/g)).toHaveLength(1)
  })

  test('a replace key wins over a self-closing empty tag', () => {
    const empty = real.replace('<filterPresetNames />', '<sinkOverrideNames />\n\t\t<sinkOverrideStates />')
    const out = renderModSettings(empty, forced)
    expect(out).toContain('<li>RollingJson</li>')
    expect(out).not.toContain('<sinkOverrideNames />')
  })

  test('replace leaves a key it does not name alone', () => {
    expect(renderModSettings(real, forced)).toContain('<filterPresetNames />')
  })

  test('a long run of indent inside the block is trimmed in linear time', () => {
    const padded = real.replace('<filterPresetNames />', `${' '.repeat(200_000)}<filterPresetNames />`)
    const start = performance.now()
    const out = renderModSettings(padded, block)
    expect(performance.now() - start).toBeLessThan(500)
    expect(out).toContain(`${' '.repeat(200_000)}<filterPresetNames />`)
    expect(out).toContain('<li>RollingJson</li>')
  })
})
