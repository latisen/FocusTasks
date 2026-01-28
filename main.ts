import {
  App,
  ItemView,
  Plugin,
  TFile,
  WorkspaceLeaf,
  debounce
} from "obsidian";

const VIEW_TYPE = "focus-tasks-view";

type TaskItem = {
  file: TFile;
  line: number;
  text: string;
  completed: boolean;
  project?: string;
  due?: string;
};

class TaskIndex {
  private app: App;
  private refreshDebounced: () => void;
  tasks: TaskItem[] = [];
  onChange?: () => void;

  constructor(app: App) {
    this.app = app;
    this.refreshDebounced = debounce(() => {
      this.refresh().catch(console.error);
    }, 400);
  }

  triggerRefresh(): void {
    this.refreshDebounced();
  }

  async refresh(): Promise<void> {
    const files = this.app.vault.getMarkdownFiles();
    const tasks: TaskItem[] = [];

    for (const file of files) {
      const content = await this.app.vault.read(file);
      const lines = content.split(/\r?\n/);

      for (let i = 0; i < lines.length; i += 1) {
        const lineText = lines[i];
        const match = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(lineText);
        if (!match) {
          continue;
        }

        const parsed = parseTaskMetadata(match[2].trim());

        tasks.push({
          file,
          line: i + 1,
          text: parsed.text,
          completed: match[1].toLowerCase() === "x",
          project: parsed.project,
          due: parsed.due
        });
      }
    }

    this.tasks = tasks;
    this.onChange?.();
  }
}

class FocusTasksView extends ItemView {
  private index: TaskIndex;
  private showCompleted = false;
  private listEl?: HTMLElement;
  private selectedSection: "inbox" = "inbox";

  constructor(leaf: WorkspaceLeaf, index: TaskIndex) {
    super(leaf);
    this.index = index;
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return "FocusTasks";
  }

  async onOpen(): Promise<void> {
    this.containerEl.addClass("focus-tasks-view");
    this.render();
    this.index.onChange = () => this.render();
  }

  onClose(): void {
    this.index.onChange = undefined;
  }

  private render(): void {
    const { containerEl } = this;
    containerEl.empty();

    const header = containerEl.createDiv("focus-tasks-header");
    header.createEl("div", { text: "FocusTasks" }).addClass("focus-tasks-title");

    const toggleCompleted = header.createEl("button", {
      text: this.showCompleted ? "Dölj klara" : "Visa klara"
    });
    toggleCompleted.addEventListener("click", () => {
      this.showCompleted = !this.showCompleted;
      this.render();
    });

    const layout = containerEl.createDiv("focus-tasks-layout");
    const sidebar = layout.createDiv("focus-tasks-sidebar");
    const content = layout.createDiv("focus-tasks-content");

    const inboxButton = sidebar.createEl("button", {
      text: "Inbox"
    });
    inboxButton.addClass("focus-tasks-nav-item");
    inboxButton.toggleClass("is-active", this.selectedSection === "inbox");
    inboxButton.addEventListener("click", () => {
      this.selectedSection = "inbox";
      this.render();
    });

    this.listEl = content.createDiv("focus-tasks-list");

    const tasks = this.index.tasks.filter((task) => {
      if (!this.showCompleted && task.completed) {
        return false;
      }
      if (this.selectedSection === "inbox") {
        return !task.project && !task.due;
      }
      return true;
    });

    if (tasks.length === 0) {
      this.listEl.createEl("div", { text: "Inga uppgifter ännu." });
      return;
    }

    for (const task of tasks) {
      const row = this.listEl.createDiv("focus-tasks-item");
      row.toggleClass("is-complete", task.completed);

      row.createEl("input", {
        type: "checkbox",
        attr: { disabled: "true" }
      }).checked = task.completed;

      const text = row.createEl("span", { text: task.text });
      text.addClass("focus-tasks-text");

      if (task.project || task.due) {
        const meta = row.createEl("span", {
          text: [task.project, task.due].filter(Boolean).join(" • ")
        });
        meta.addClass("focus-tasks-meta");
      }

      const openButton = row.createEl("button", {
        text: task.file.basename
      });
      openButton.addClass("focus-tasks-file");
      openButton.addEventListener("click", () => {
        this.app.workspace.getLeaf(false).openFile(task.file);
      });
    }
  }
}

export default class FocusTasksPlugin extends Plugin {
  private index!: TaskIndex;

  async onload(): Promise<void> {
    this.index = new TaskIndex(this.app);

    this.registerView(VIEW_TYPE, (leaf) => new FocusTasksView(leaf, this.index));

    this.addRibbonIcon("check-square", "FocusTasks", () => {
      this.activateView().catch(console.error);
    });

    this.addCommand({
      id: "focus-tasks-open",
      name: "Open FocusTasks",
      callback: () => this.activateView()
    });

    this.registerEvent(
      this.app.vault.on("modify", (file) => this.onFileChange(file))
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => this.onFileChange(file))
    );
    this.registerEvent(
      this.app.vault.on("rename", (file) => this.onFileChange(file))
    );

    await this.index.refresh();
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  private onFileChange(file: TFile | null): void {
    if (!file || file.extension !== "md") {
      return;
    }
    this.index.triggerRefresh();
  }

  private async activateView(): Promise<void> {
    const { workspace } = this.app;

    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];

    if (!leaf) {
      leaf = workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }

    workspace.revealLeaf(leaf);
  }
}

function parseTaskMetadata(rawText: string): {
  text: string;
  project?: string;
  due?: string;
} {
  let text = rawText;
  let project: string | undefined;
  let due: string | undefined;

  const projectMatch = /(?:^|\s)project::\s*([^\n]+?)(?=\s+due::|$)/i.exec(text);
  if (projectMatch) {
    project = projectMatch[1].trim();
    text = text.replace(projectMatch[0], " ");
  }

  const dueMatch = /(?:^|\s)due::\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/i.exec(text);
  if (dueMatch) {
    due = dueMatch[1];
    text = text.replace(dueMatch[0], " ");
  }

  return { text: text.trim(), project, due };
}
