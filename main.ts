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
  planned?: string;
  due?: string;
  tags: string[];
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
        if (!parsed.text) {
          continue;
        }

        tasks.push({
          file,
          line: i + 1,
          text: parsed.text,
          completed: match[1].toLowerCase() === "x",
          project: parsed.project,
          planned: parsed.planned,
          due: parsed.due,
          tags: parsed.tags
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
  private selectedSection: "inbox" | "today" | "projects" = "inbox";
  private sectionExpanded = new Map<string, boolean>();
  private expandedTasks = new Set<string>();

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

    const todayButton = sidebar.createEl("button", {
      text: "Today"
    });
    todayButton.addClass("focus-tasks-nav-item");
    todayButton.toggleClass("is-active", this.selectedSection === "today");
    todayButton.addEventListener("click", () => {
      this.selectedSection = "today";
      this.render();
    });

    const projectsButton = sidebar.createEl("button", {
      text: "Projekt"
    });
    projectsButton.addClass("focus-tasks-nav-item");
    projectsButton.toggleClass("is-active", this.selectedSection === "projects");
    projectsButton.addEventListener("click", () => {
      this.selectedSection = "projects";
      this.render();
    });

    if (this.selectedSection === "inbox") {
      this.listEl = content.createDiv("focus-tasks-list");

      const tasks = this.index.tasks.filter((task) => {
        if (!this.showCompleted && task.completed) {
          return false;
        }
        return !task.project && !task.due && !task.planned;
      });

      if (tasks.length === 0) {
        this.listEl.createEl("div", { text: "Inga uppgifter ännu." });
        return;
      }

      for (const task of tasks) {
        this.renderTaskRow(task, this.listEl);
      }
      return;
    }

    if (this.selectedSection === "projects") {
      const projects = groupTasksByProject(
        this.app,
        this.index.tasks,
        !this.showCompleted
      );

      if (projects.size === 0) {
        content.createEl("div", { text: "Inga projekt ännu." });
        return;
      }

      for (const [projectName, tasks] of projects) {
        const sorted = sortTasksByDate(tasks);
        this.renderSection(content, projectName, sorted, `project:${projectName}`);
      }
      return;
    }

    const today = getLocalDateString();
    const tomorrow = getLocalDateString(1);

    const overdue = this.index.tasks.filter((task) => {
      if (!this.showCompleted && task.completed) {
        return false;
      }
      const plannedDate = parseDate(task.planned);
      const dueDate = parseDate(task.due);
      if (dueDate) {
        return dueDate < today;
      }
      if (plannedDate) {
        return plannedDate < today;
      }
      return false;
    });

    const plannedToday = this.index.tasks.filter((task) => {
      if (!this.showCompleted && task.completed) {
        return false;
      }
      const plannedDate = parseDate(task.planned);
      const dueDate = parseDate(task.due);
      if (plannedDate && dueDate) {
        return plannedDate <= today && today <= dueDate;
      }
      if (plannedDate && !dueDate) {
        return plannedDate === today;
      }
      return false;
    });

    const plannedTomorrow = this.index.tasks.filter((task) => {
      if (!this.showCompleted && task.completed) {
        return false;
      }
      const plannedDate = parseDate(task.planned);
      return plannedDate === tomorrow;
    });

    this.renderSection(content, "Överfört", overdue, "overdue");
    this.renderSection(content, "Planerat idag", plannedToday, "planned-today");
    this.renderSection(
      content,
      "Planerat imorgon",
      plannedTomorrow,
      "planned-tomorrow"
    );
  }

  private renderSection(
    container: HTMLElement,
    title: string,
    tasks: TaskItem[],
    key: string
  ): void {
    const section = container.createDiv("focus-tasks-section");
    const header = section.createDiv("focus-tasks-section-header");
    header.createEl("span", { text: title });

    const isExpanded = this.sectionExpanded.get(key) ?? true;
    const toggle = header.createEl("button", {
      text: isExpanded ? "Dölj" : "Visa"
    });
    toggle.addClass("focus-tasks-section-toggle");
    toggle.addEventListener("click", () => {
      this.sectionExpanded.set(key, !isExpanded);
      this.render();
    });

    if (!isExpanded) {
      return;
    }

    const list = section.createDiv("focus-tasks-list");
    if (tasks.length === 0) {
      list.createEl("div", { text: "Inga uppgifter." });
      return;
    }

    for (const task of tasks) {
      this.renderTaskRow(task, list);
    }
  }

  private renderTaskRow(task: TaskItem, container: HTMLElement): void {
    const taskKey = `${task.file.path}:${task.line}`;
    const row = container.createDiv("focus-tasks-item");
    row.toggleClass("is-complete", task.completed);
    row.toggleClass("is-collapsed", !this.expandedTasks.has(taskKey));

    row.createEl("input", {
      type: "checkbox",
      attr: { disabled: "true" }
    }).checked = task.completed;

    const main = row.createDiv("focus-tasks-main");

    const headerRow = main.createDiv("focus-tasks-header-row");

    const textInput = headerRow.createEl("input", {
      type: "text"
    });
    textInput.value = task.text;
    textInput.addClass("focus-tasks-text-input");
    textInput.addEventListener("blur", () => {
      if (textInput.value.trim() === task.text) {
        return;
      }
      updateTaskInFile(this.app, task, { text: textInput.value.trim() })
        .then(() => this.index.triggerRefresh())
        .catch(console.error);
    });
    textInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        textInput.blur();
      }
    });

    const details = main.createDiv("focus-tasks-details");
    const noteRow = details.createDiv("focus-tasks-note-row");
    const openButton = noteRow.createEl("button", {
      text: task.file.basename
    });
    openButton.addClass("focus-tasks-file");
    openButton.addEventListener("click", () => {
      this.app.workspace.getLeaf(false).openFile(task.file);
    });

    const metaRow = details.createDiv("focus-tasks-meta-row");

    const plannedWrap = metaRow.createDiv("focus-tasks-date");
    plannedWrap.createEl("span", { text: "Planerad" });
    const plannedInput = plannedWrap.createEl("input", { type: "date" });
    plannedInput.value = task.planned ?? "";
    plannedInput.addEventListener("change", () => {
      updateTaskInFile(this.app, task, {
        planned: plannedInput.value || undefined
      })
        .then(() => this.index.triggerRefresh())
        .catch(console.error);
    });

    const dueWrap = metaRow.createDiv("focus-tasks-date");
    dueWrap.createEl("span", { text: "Due" });
    const dueInput = dueWrap.createEl("input", { type: "date" });
    dueInput.value = task.due ?? "";
    dueInput.addEventListener("change", () => {
      updateTaskInFile(this.app, task, {
        due: dueInput.value || undefined
      })
        .then(() => this.index.triggerRefresh())
        .catch(console.error);
    });

    if (task.tags.length > 0) {
      const tagsWrap = metaRow.createDiv("focus-tasks-tags");
      for (const tag of task.tags) {
        const tagEl = tagsWrap.createEl("span", { text: tag });
        tagEl.addClass("focus-tasks-tag");
      }
    }

    const toggle = row.createEl("button", { text: "▸" });
    toggle.addClass("focus-tasks-toggle");
    toggle.addEventListener("click", () => {
      if (this.expandedTasks.has(taskKey)) {
        this.expandedTasks.delete(taskKey);
      } else {
        this.expandedTasks.add(taskKey);
      }
      this.render();
    });
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
  planned?: string;
  due?: string;
  tags: string[];
} {
  let text = rawText;
  let project: string | undefined;
  let planned: string | undefined;
  let due: string | undefined;

  const projectResult = extractMetadata(text, "project");
  if (projectResult.value) {
    project = normalizeProjectName(projectResult.value);
    text = projectResult.text;
  } else {
    const projectAlt = extractMetadata(text, "projekt");
    project = projectAlt.value
      ? normalizeProjectName(projectAlt.value)
      : undefined;
    text = projectAlt.text;
  }

  const plannedResult = extractMetadata(text, "planned");
  planned = plannedResult.value;
  text = plannedResult.text;

  const dueResult = extractMetadata(text, "due");
  due = dueResult.value;
  text = dueResult.text;

  const tagResult = extractTags(text);
  text = tagResult.text;

  return { text: text.trim(), project, planned, due, tags: tagResult.tags };
}

function extractMetadata(
  text: string,
  key: "project" | "projekt" | "planned" | "due"
): { text: string; value?: string } {
  const regex = new RegExp(
    `(?:^|\\s)${key}::\\s*([^\\n]+?)(?=\\s+\\w+::|$)`,
    "i"
  );
  const match = regex.exec(text);
  if (!match) {
    return { text };
  }
  let value = match[1].trim();
  if (key === "planned" || key === "due") {
    value = normalizeDateString(value);
  }
  return {
    text: text.replace(match[0], " "),
    value
  };
}

function extractTags(text: string): { text: string; tags: string[] } {
  const tags = text.match(/#[-\w/]+/g);
  if (!tags) {
    return { text, tags: [] };
  }
  const unique = Array.from(new Set(tags));
  const cleaned = text.replace(/#[-\w/]+/g, " ").replace(/\s+/g, " ");
  return { text: cleaned, tags: unique };
}

function getLocalDateString(addDays = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + addDays);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeDateString(value: string): string {
  const token = value.split(/\s+/)[0];
  if (/^\d{4}-\d{2}-\d{2}$/.test(token)) {
    return token;
  }
  return value.trim();
}

function normalizeProjectName(value: string): string {
  const trimmed = value.trim();
  const wikilinkMatch = /\[\[([^\]]+)\]\]/.exec(trimmed);
  if (wikilinkMatch) {
    return wikilinkMatch[1].trim();
  }
  return trimmed.replace(/#[-\w/]+/g, " ").replace(/\s+/g, " ").trim();
}

function parseDate(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = normalizeDateString(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : undefined;
}

function groupTasksByProject(
  app: App,
  tasks: TaskItem[],
  hideCompleted: boolean
): Map<string, TaskItem[]> {
  const result = new Map<string, TaskItem[]>();
  for (const task of tasks) {
    if (hideCompleted && task.completed) {
      continue;
    }
    const project = task.project ?? getProjectName(app, task.file);
    if (!project) {
      continue;
    }
    const existing = result.get(project) ?? [];
    existing.push(task);
    result.set(project, existing);
  }
  return new Map(
    Array.from(result.entries()).sort(([a], [b]) => a.localeCompare(b))
  );
}

function getProjectName(app: App, file: TFile): string | undefined {
  const cache = app.metadataCache.getFileCache(file);
  const project = cache?.frontmatter?.projekt;
  if (!project) {
    return undefined;
  }
  if (Array.isArray(project)) {
    return project.map((value) => normalizeProjectName(String(value))).join(", ");
  }
  return normalizeProjectName(String(project));
}

function sortTasksByDate(tasks: TaskItem[]): TaskItem[] {
  return [...tasks].sort((a, b) => {
    const aDate = parseDate(a.planned) ?? parseDate(a.due);
    const bDate = parseDate(b.planned) ?? parseDate(b.due);
    if (aDate && bDate) {
      return aDate.localeCompare(bDate);
    }
    if (aDate && !bDate) {
      return -1;
    }
    if (!aDate && bDate) {
      return 1;
    }
    return a.text.localeCompare(b.text);
  });
}


async function updateTaskInFile(
  app: App,
  task: TaskItem,
  updates: { text?: string; project?: string; planned?: string; due?: string }
): Promise<void> {
  const content = await app.vault.read(task.file);
  const lines = content.split(/\r?\n/);
  const index = task.line - 1;

  if (index < 0 || index >= lines.length) {
    return;
  }

  const lineText = lines[index];
  const match = /^(\s*[-*])\s+\[( |x|X)\]\s+(.*)$/.exec(lineText);
  if (!match) {
    return;
  }

  const bullet = match[1];
  const checkbox = match[2];
  const current = parseTaskMetadata(match[3]);

  const text = (updates.text ?? current.text).trim();
  const project = updates.project ?? current.project;
  const planned = updates.planned ?? current.planned;
  const due = updates.due ?? current.due;

  const metaParts: string[] = [];
  const projectKey = /(?:^|\s)projekt::/i.test(match[3])
    ? "projekt"
    : "project";
  if (project) {
    metaParts.push(`${projectKey}:: ${project}`);
  }
  if (planned) {
    metaParts.push(`planned:: ${planned}`);
  }
  if (due) {
    metaParts.push(`due:: ${due}`);
  }

  const tags = current.tags.length > 0 ? ` ${current.tags.join(" ")}` : "";

  const meta = metaParts.length > 0 ? ` ${metaParts.join(" ")}` : "";
  lines[index] = `${bullet} [${checkbox}] ${text}${meta}${tags}`.trimEnd();

  await app.vault.modify(task.file, lines.join("\n"));
}
