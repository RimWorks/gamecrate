import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { glob, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  mergePrefsXml,
  parseAboutXml,
  parsePrefsXml,
  writeModsConfigXml,
  writePrefsXml,
} from '../src/xml'
import type { ModManifest } from '@gamecrate/cli'

/** Point this at a workshop content root to check the parser against a real library. */
const CORPUS = process.env['GAMECRATE_RIMWORLD_CORPUS']

/** Workshop item 1195427067, verbatim: its own packageId sits last, after a dependency's. */
const ARCHITECT_ICONS = `<?xml version="1.0" encoding="utf-8"?>
<ModMetaData>
\t<name>Architect Icons</name>
\t<author>marcin212</author>
    <supportedVersions>
\t\t<li>1.0</li>
\t\t<li>1.6</li>
    </supportedVersions>
\t<modDependencies>
\t\t<li>
\t\t\t<packageId>brrainz.harmony</packageId>
\t\t\t<displayName>Harmony</displayName>
\t\t\t<steamWorkshopUrl>steam://url/CommunityFilePage/2009463077</steamWorkshopUrl>
\t\t\t<downloadUrl>https://github.com/pardeike/HarmonyRimWorld/releases/latest</downloadUrl>
\t\t</li>
\t</modDependencies>\t
\t<loadAfter>
\t\t<li>brrainz.harmony</li>
\t</loadAfter>
\t<description>V1.9
    This mod adds icons to architect tab.
\t</description>
\t<packageId>com.bymarcin.ArchitectIcons</packageId>
</ModMetaData>`

/** Every case in this block is a real mod, so a null here is the test failing, not a skip. */
function about(text: string): ModManifest {
  const manifest = parseAboutXml(text)
  if (manifest === null) throw new Error('expected a manifest, got null')
  return manifest
}

describe('parseAboutXml', () => {
  test('returns the top-level packageId, not a dependency (item 1195427067)', () => {
    const manifest = about(ARCHITECT_ICONS)
    expect(manifest.packageId).toBe('com.bymarcin.ArchitectIcons')
    expect(manifest.name).toBe('Architect Icons')
  })

  test('the naive grep this replaces gets that file wrong', () => {
    const naive = /<packageId>([^<]+)/.exec(ARCHITECT_ICONS)?.[1]
    expect(naive).toBe('brrainz.harmony')
    expect(about(ARCHITECT_ICONS).packageId).not.toBe(naive)
  })

  test('reads dependencies with their steamWorkshopUrl hint', () => {
    const manifest = about(ARCHITECT_ICONS)
    expect(manifest.modDependencies).toEqual([
      {
        packageId: 'brrainz.harmony',
        steamWorkshopUrl: 'steam://url/CommunityFilePage/2009463077',
      },
    ])
    expect(manifest.loadAfter).toEqual(['brrainz.harmony'])
    expect(manifest.loadBefore).toEqual([])
  })

  test('preserves manifest casing', () => {
    const manifest = about(
      '<ModMetaData><packageId>CryptikLemur.StickToYourSave</packageId></ModMetaData>',
    )
    expect(manifest.packageId).toBe('CryptikLemur.StickToYourSave')
  })

  test('omits a dependency with no packageId and keeps one without a url', () => {
    const manifest = about(`<ModMetaData>
      <packageId>Example.Core</packageId>
      <modDependencies>
        <li><displayName>Nameless</displayName></li>
        <li><packageId>samplelib.sample</packageId><displayName>Sample</displayName></li>
      </modDependencies>
    </ModMetaData>`)
    expect(manifest.modDependencies).toEqual([{ packageId: 'samplelib.sample' }])
  })

  test('reads every ordering list', () => {
    const manifest = about(`<ModMetaData>
      <packageId>a.b</packageId>
      <loadAfter><li>x.one</li><li>x.two</li></loadAfter>
      <loadBefore><li>y.one</li></loadBefore>
      <forceLoadBefore><li>z.one</li></forceLoadBefore>
      <incompatibleWith><li>bad.mod</li></incompatibleWith>
    </ModMetaData>`)
    expect(manifest.loadAfter).toEqual(['x.one', 'x.two'])
    expect(manifest.loadBefore).toEqual(['y.one'])
    expect(manifest.forceLoadBefore).toEqual(['z.one'])
    expect(manifest.incompatibleWith).toEqual(['bad.mod'])
  })

  test('ignores comments, CDATA, PIs, self-closing tags and attributes', () => {
    const manifest = about(`<?xml version="1.0" encoding="utf-8"?>
      <!-- List of packageIds of any mods which are incompatible -->
      <ModMetaData Version="1.6">
        <!-- <packageId>decoy.commented</packageId> -->
        <descriptionsByVersion />
        <description><![CDATA[<packageId>decoy.cdata</packageId>]]></description>
        <packageId>real.one</packageId>
      </ModMetaData>`)
    expect(manifest.packageId).toBe('real.one')
  })

  test('decodes entities in text', () => {
    const manifest = about(
      '<ModMetaData><packageId>a.b</packageId><name>Investiture &amp; Connection &#65;</name></ModMetaData>',
    )
    expect(manifest.name).toBe('Investiture & Connection A')
  })

  test('handles version-keyed element names like <v1.6>', () => {
    const manifest = about(`<ModMetaData>
      <packageId>Doug.NoJobAuthors</packageId>
      <modDependenciesByVersion>
        <v1.6><li><packageId>brrainz.harmony</packageId></li></v1.6>
      </modDependenciesByVersion>
    </ModMetaData>`)
    expect(manifest.packageId).toBe('Doug.NoJobAuthors')
    expect(manifest.modDependencies).toEqual([])
  })

  test('returns null when there is no top-level packageId', () => {
    expect(
      parseAboutXml(
        '<ModMetaData><modDependencies><li><packageId>brrainz.harmony</packageId></li></modDependencies></ModMetaData>',
      ),
    ).toBeNull()
  })

  test('throws on unbalanced tags', () => {
    expect(() => parseAboutXml('<ModMetaData><packageId>a.b</name></ModMetaData>')).toThrow(
      /malformed XML/,
    )
  })

  test('throws on an empty document', () => {
    expect(() => parseAboutXml('   ')).toThrow(/root element/)
  })

  test('an unknown entity is an error, not silent text', () => {
    expect(() => parseAboutXml('<ModMetaData><packageId>a&nbsp;b</packageId></ModMetaData>')).toThrow(
      /malformed XML/,
    )
  })

  test('a valueless attribute is an error', () => {
    expect(() => parseAboutXml('<ModMetaData hidden><packageId>a.b</packageId></ModMetaData>')).toThrow(
      /malformed XML/,
    )
  })

  test('a DOCTYPE parses, and its external part is never fetched', () => {
    const withDoctype =
      '<!DOCTYPE ModMetaData SYSTEM "https://nope.invalid/mod.dtd">\n<ModMetaData><packageId>a.b</packageId></ModMetaData>'
    expect(parseAboutXml(withDoctype)?.packageId).toBe('a.b')
  })

  // Nothing in About.xml uses one, and honoring them would mean parsing the internal subset.
  test('an entity declared in the internal subset is still undefined', () => {
    const withEntity =
      '<!DOCTYPE ModMetaData [<!ENTITY who "a.b">]>\n<ModMetaData><packageId>&who;</packageId></ModMetaData>'
    expect(() => parseAboutXml(withEntity)).toThrow(/undefined entity/)
  })
})

describe('parseAboutXml over a real library', () => {
  test.skipIf(CORPUS === undefined || !existsSync(CORPUS))('every About.xml in the corpus parses', async () => {
    const found = glob('*/About/About.xml', { cwd: CORPUS! })
    let parsed = 0
    let notMods = 0
    for await (const path of found) {
      const manifest = parseAboutXml(await readFile(join(CORPUS!, path), 'utf8'))
      if (manifest === null) notMods++
      else parsed++
    }
    expect(parsed).toBeGreaterThan(0)
    expect(parsed).toBeGreaterThan(notMods)
  })
})

describe('writeModsConfigXml', () => {
  test('writes the RimWorld layout with casing preserved', () => {
    expect(
      writeModsConfigXml({
        version: '1.6.4871 rev600',
        activeMods: ['ludeon.rimworld', 'Example.Core'],
        knownExpansions: ['ludeon.rimworld.royalty'],
      }),
    ).toBe(
      `<?xml version="1.0" encoding="utf-8"?>
<ModsConfigData>
  <version>1.6.4871 rev600</version>
  <activeMods>
    <li>ludeon.rimworld</li>
    <li>Example.Core</li>
  </activeMods>
  <knownExpansions>
    <li>ludeon.rimworld.royalty</li>
  </knownExpansions>
</ModsConfigData>
`,
    )
  })

  test('collapses empty lists and round-trips through the parser', () => {
    const xml = writeModsConfigXml({ version: '1.6', activeMods: [], knownExpansions: [] })
    expect(xml).toContain('  <activeMods />')
    expect(xml).toContain('  <knownExpansions />')
    const parsed = parsePrefsXml(xml)
    expect(parsed.get('version')).toBe('1.6')
    expect(parsed.get('activeMods')).toBe('')
  })
})

const LIVE_PREFS = `<?xml version="1.0" encoding="utf-8"?>
<PrefsData>
  <volumeMaster>0.05405398</volumeMaster>
  <uiScale>1</uiScale>
  <temperatureMode>Celsius</temperatureMode>
  <langFolderName>English</langFolderName>
  <preferredNames />
  <resetModsConfigOnCrash>True</resetModsConfigOnCrash>
  <devMode>False</devMode>
  <debugActionPalette>
    <li>Actions\\T: Kill</li>
  </debugActionPalette>
  <devPalettePosition>
    <x>1903</x>
    <y>354</y>
  </devPalettePosition>
</PrefsData>`

describe('parsePrefsXml', () => {
  test('reads scalars, empty elements and nested blocks', () => {
    const entries = parsePrefsXml(LIVE_PREFS)
    expect(entries.get('volumeMaster')).toBe('0.05405398')
    expect(entries.get('temperatureMode')).toBe('Celsius')
    expect(entries.get('preferredNames')).toBe('')
    expect(entries.get('devPalettePosition')).toContain('<x>1903</x>')
  })

  test('keeps document order', () => {
    expect([...parsePrefsXml(LIVE_PREFS).keys()].slice(0, 3)).toEqual([
      'volumeMaster',
      'uiScale',
      'temperatureMode',
    ])
  })

  test('strips a BOM', () => {
    expect(parsePrefsXml('﻿<PrefsData><devMode>True</devMode></PrefsData>').get('devMode')).toBe(
      'True',
    )
  })
})

describe('writePrefsXml', () => {
  test('round-trips the live document byte for byte', () => {
    expect(writePrefsXml(parsePrefsXml(LIVE_PREFS))).toBe(`${LIVE_PREFS}\n`)
  })

  test('escapes scalar values but not nested markup', () => {
    const xml = writePrefsXml(
      new Map([
        ['langFolderName', 'A & B'],
        ['devPalettePosition', '\n    <x>1</x>\n  '],
      ]),
    )
    expect(xml).toContain('<langFolderName>A &amp; B</langFolderName>')
    expect(xml).toContain('<devPalettePosition>\n    <x>1</x>\n  </devPalettePosition>')
    expect(parsePrefsXml(xml).get('langFolderName')).toBe('A & B')
  })

  test('rejects a key that is not an XML name instead of writing a broken file', () => {
    for (const key of ['bad key', 'a>b', '</PrefsData><evil', '1st', '', 'a\nb', 'a"b']) {
      expect(() => writePrefsXml(new Map([[key, '1']]))).toThrow(/not an XML name/)
    }
  })

  test('accepts the unicode and punctuation XML names allow', () => {
    const xml = writePrefsXml(new Map([['réglage.ui-scale_2:x', '1']]))
    expect(parsePrefsXml(xml).get('réglage.ui-scale_2:x')).toBe('1')
  })
})

describe('mergePrefsXml', () => {
  test('an unowned key survives untouched (landmine 6)', () => {
    const merged = mergePrefsXml(LIVE_PREFS, { devMode: 'True' })
    const entries = parsePrefsXml(merged)
    expect(entries.get('volumeMaster')).toBe('0.05405398')
    expect(entries.get('uiScale')).toBe('1')
    expect(entries.get('temperatureMode')).toBe('Celsius')
    expect(entries.get('langFolderName')).toBe('English')
    expect(entries.get('devPalettePosition')).toContain('<y>354</y>')
    expect(entries.get('devMode')).toBe('True')
  })

  test('replaces owned keys in place and keeps every other key in original order', () => {
    const before = [...parsePrefsXml(LIVE_PREFS).keys()]
    const after = [...parsePrefsXml(
      mergePrefsXml(LIVE_PREFS, { resetModsConfigOnCrash: 'False', devMode: 'True' }),
    ).keys()]
    expect(after).toEqual(before)
    expect(parsePrefsXml(mergePrefsXml(LIVE_PREFS, { resetModsConfigOnCrash: 'False' })).get(
      'resetModsConfigOnCrash',
    )).toBe('False')
  })

  test('appends owned keys the existing document lacks', () => {
    const entries = parsePrefsXml(mergePrefsXml(LIVE_PREFS, { runInBackground: 'True' }))
    expect([...entries.keys()].at(-1)).toBe('runInBackground')
    expect(entries.get('runInBackground')).toBe('True')
  })

  test('writes a fresh document when existing is null', () => {
    expect(mergePrefsXml(null, { screenWidth: '1920', fullscreen: 'False' })).toBe(
      `<?xml version="1.0" encoding="utf-8"?>
<PrefsData>
  <screenWidth>1920</screenWidth>
  <fullscreen>False</fullscreen>
</PrefsData>
`,
    )
  })

  test('treats a blank existing document as fresh', () => {
    expect(mergePrefsXml('  \n', { devMode: 'True' })).toBe(
      mergePrefsXml(null, { devMode: 'True' }),
    )
  })

  test('a bad owned key throws before the nested existing prefs are touched', () => {
    expect(() => mergePrefsXml(LIVE_PREFS, { 'bad key': '1' })).toThrow(/not an XML name/)
  })

  test('malformed existing prefs throw rather than silently starting over', () => {
    expect(() => mergePrefsXml('<PrefsData><devMode>True</PrefsData>', { devMode: 'True' })).toThrow(
      /malformed XML/,
    )
  })

  test('a merged document re-merges identically', () => {
    const once = mergePrefsXml(LIVE_PREFS, { devMode: 'True', resetModsConfigOnCrash: 'False' })
    const twice = mergePrefsXml(once, { devMode: 'True', resetModsConfigOnCrash: 'False' })
    expect(twice).toBe(once)
  })
})
