import type { App } from 'obsidian';
import { Modal, Setting } from 'obsidian';

export const NATIVE_MCP_HELP_URL = 'https://code.claude.com/docs/en/mcp';

export interface ClaudeNativeMcpCutoverModalOptions {
  onConfirm: () => void | Promise<void>;
  onLater: () => void;
}

/**
 * One-shot cutover notice (design §5.1): fixed copy explaining what changed,
 * with exactly three actions — view help, later, explicit confirmation.
 *
 * It intentionally takes no server data, so it can never display
 * configuration values, and it offers no export/delete/migrate actions: the
 * confirmation is the user accepting native management, not a migration.
 */
export class ClaudeNativeMcpCutoverModal extends Modal {
  private readonly options: ClaudeNativeMcpCutoverModalOptions;

  constructor(app: App, options: ClaudeNativeMcpCutoverModalOptions) {
    super(app);
    this.options = options;
  }

  onOpen(): void {
    this.setTitle('Claude MCP servers now use native configuration');
    this.modalEl.addClass('claudian-mcp-cutover-modal');

    const { contentEl } = this;

    contentEl.createDiv({
      cls: 'setting-item-description',
      text:
        'Claudian no longer manages MCP servers. Claude reads them natively from its own '
        + 'configuration files (project .mcp.json, user and managed settings), managed with the '
        + 'Claude CLI. Keep using the same working directory, home, and CLI target.',
    });

    contentEl.createDiv({
      cls: 'setting-item-description',
      text:
        'Your old configuration file remains untouched — it is kept as-is and simply not used '
        + 'anymore, so servers previously enabled only through Claudian may stop working. A native '
        + 'server with the same name as an old one may now become active. Per-server switches '
        + 'such as fine-grained tool restrictions and context-saving are retired; configure '
        + 'equivalent restrictions natively if you need them.',
    });

    contentEl.createDiv({
      cls: 'setting-item-description',
      text:
        'By confirming, you state that you have reviewed your native MCP configuration '
        + '(including same-name servers and tool restrictions). Claude requests stay blocked '
        + 'until you confirm. Your history remains readable.',
    });

    const helpLine = contentEl.createDiv({
      cls: 'setting-item-description',
      text: 'How to manage MCP servers natively: ',
    });
    const helpLink = helpLine.createEl('a', { text: 'View MCP help' });
    helpLink.setAttribute('href', NATIVE_MCP_HELP_URL);

    new Setting(contentEl)
      .addButton(button => button
        .setButtonText('Later')
        .onClick(() => {
          this.options.onLater();
          this.close();
        }))
      .addButton(button => button
        .setButtonText('I reviewed my native MCP configuration — confirm')
        .setCta()
        .onClick(() => {
          void this.options.onConfirm();
        }));
  }
}
