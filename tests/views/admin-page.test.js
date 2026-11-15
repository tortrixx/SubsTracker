// @ts-check
import { describe, expect, it } from 'vitest';
import adminPage from '../../src/views/adminPage.html';
import themeResources from '../../src/views/theme-resources.html';

describe('admin page subscription list', () => {
  it('re-renders the subscription table when the lunar display checkbox changes', () => {
    expect(adminPage).toMatch(
      /listShowLunar\.addEventListener\(['"]change['"],\s*handleListLunarToggle\)/
    );
  });

  it('does not wrap action buttons inside a div[role="button"] row', () => {
    expect(adminPage).not.toMatch(/class="st-row"[^>]*role="button"/);
    expect(adminPage).toMatch(/class="st-icon-btn expand-btn"/);
  });

  it('includes smart reminder preview box wired to /api/reminders/preview', () => {
    expect(adminPage).toContain('id="rulePreviewBox"');
    expect(adminPage).toContain('/api/reminders/preview');
  });
});

describe('theme-resources String.replace safety & shell accessibility', () => {
  it('contains no bare $ replacement hazard sequences for pages.ts', () => {
    expect(themeResources).not.toMatch(/\$(['`$]|&)/);
  });

  it('marks active navigation items with aria-current="page"', () => {
    expect(themeResources).toContain('aria-current="page"');
  });

  it('registers the SVG favicon once and renders the SVG brand mark in shell', () => {
    const matches = themeResources.match(/href="\/favicon\.svg"/g) || [];
    expect(matches).toHaveLength(1);
    expect(themeResources).toContain('<span class="st-brand-mark">\' + brandSvg + \'</span>');
  });
});
