import { Fragment, useMemo, type ReactNode } from 'react';
import { compiler, astToJSX, RuleType, type MarkdownToJSX } from 'markdown-to-jsx/react';
import { Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';

function MarkdownLink({ href, title, children }: { href?: string; title?: string; children?: ReactNode }) {
  if (!href || !URL.canParse(href, window.location.href)) return <>{children}</>;
  const url = new URL(href, window.location.href);
  if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return <>{children}</>;
  if (url.origin === window.location.origin) {
    return <Link to={url.pathname + url.search + url.hash} title={title}>{children}</Link>;
  }
  return <a href={url.href} title={title} target="_blank" rel="noopener noreferrer">{children}</a>;
}

const markdownOptions: MarkdownToJSX.Options = {
  wrapper: Fragment,
  disableParsingRawHTML: true,
  preserveFrontmatter: true,
  overrides: {
    a: MarkdownLink,
    img: ({ alt }: { alt?: string }) => <>{alt}</>,
  },
};

type Props = {
  text: string;
  renderText: (text: string) => ReactNode;
  children?: ReactNode;
};

export function AssistantMessage({ text, renderText, children }: Props) {
  const body = useMemo(() => compiler(text, {
    ...markdownOptions,
    forceBlock: true,
    renderRule(next, node, _renderChildren, state) {
      // An explicit Markdown link owns its label, including incident IDs inside it.
      if (node.type === RuleType.link) {
        return <Fragment key={state.key}>{astToJSX([node], markdownOptions)}</Fragment>;
      }
      if (node.type === RuleType.text) {
        return <Fragment key={state.key}>{renderText(node.text)}</Fragment>;
      }
      return next();
    },
  }), [text, renderText]);

  return <div className="chat-message from-assistant">
    <div className="assistant-author"><Sparkles size={16} aria-hidden="true" />Ассистент</div>
    <div className="assistant-prose">{body}</div>
    {children}
  </div>;
}
