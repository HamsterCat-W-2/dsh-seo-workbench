window.__ModuleLoader__.load({
  id: '@local/seo-workbench',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Placeholder body; replaced by the real workbench UI in step 4. */
    function SeoWorkbenchBody() {
      return h(
        'div',
        {
          style: {
            padding: '16px',
            color: 'var(--dsw-alias-text-primary)',
            fontSize: '14px',
            lineHeight: 1.6,
          },
        },
        'SEO 分析工作台（骨架）— 输入网址后开始分析',
      );
    }

    return {
      inject: ['slots', 'sidebarRightTabs', 'sidebarRight'],
      apply(ctx) {
        ctx.effect(() => {
          const definition = {
            id: 'seo-workbench',
            kind: 'seo-workbench',
            title: () => 'SEO 分析',
            guide: [
              {
                id: 'seo-workbench',
                order: 0,
                title: () => 'SEO 分析',
                description: () => '对网站做技术 SEO 体检：可抓取性、技术基础、On-Page 与内容质量，给出评分和修复建议。',
              },
            ],
          };
          const disposers = [
            ctx.sidebarRightTabs.register(definition),
            ctx.slots.register(
              { name: 'sidebar.right.pane.tab', key: definition.id },
              SeoWorkbenchBody,
            ),
          ];
          return () => {
            for (const dispose of disposers) {
              dispose();
            }
          };
        });
      },
    };
  },
});
