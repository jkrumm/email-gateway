import { describe, expect, test } from 'bun:test'
import { CATEGORY_CRITERIA } from '../enrich/categories'
import { SYSTEM_PROMPT as ENRICHMENT_PROMPT } from '../enrich/enrich-email'
import { JEV_VERDICT_QUESTION } from '../spam/jev-judge'
import { SYSTEM_PROMPT as CLASSIFIER_PROMPT } from '../spam/classify'

// Jev's criteria mirror the LLM prompts. If a category is added or renamed in
// one place only, the shadow comparison silently stops being like-for-like.
describe('Jev criteria vs LLM prompts', () => {
  test('classifier prompt mentions every verdict Jev can choose, and every site', () => {
    for (const verdict of Object.keys(JEV_VERDICT_QUESTION.criteria)) {
      expect(CLASSIFIER_PROMPT).toContain(`"${verdict}"`)
    }
    expect(CLASSIFIER_PROMPT).toContain('"fpp"')
    expect(CLASSIFIER_PROMPT).toContain('"sy-serendipity"')
    expect(CLASSIFIER_PROMPT).toContain('"jkrumm-contact"')
  })

  test('enrichment prompt mentions every category Jev can choose', () => {
    for (const category of Object.keys(CATEGORY_CRITERIA)) {
      expect(ENRICHMENT_PROMPT).toContain(`"${category}"`)
    }
  })
})
