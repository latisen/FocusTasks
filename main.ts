import {
  App,
  ItemView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  requestUrl,
  Setting,
  TFile,
  WorkspaceLeaf,
  debounce
} from "obsidian";
import ICAL from "ical.js";

const VIEW_TYPE = "focus-tasks-view";

type TaskItem = {
  file: TFile;
  line: number;
  text: string;
  completed: boolean;
  project?: string;
  context?: string;
  planned?: string;
  due?: string;
  review?: string;
  tags: string[];
  subitems: TaskSubItem[];
};

type TaskSubItem = {
  text: string;
  completed?: boolean;
  kind: "task" | "note";
};

type CalendarEvent = {
  title: string;
  date: string;
  startTime?: string;
  endTime?: string;
  allDay: boolean;
  location?: string;
  calendarName?: string;
};

type CalendarSource = {
  name: string;
  url: string;
};

type FocusTasksSettings = {
  calendarSources: CalendarSource[];
  calendarRangeDays: number;
};

const DEFAULT_SETTINGS: FocusTasksSettings = {
  calendarSources: Array.from({ length: 10 }, () => ({ name: "", url: "" })),
  calendarRangeDays: 7
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

        const subitems: TaskSubItem[] = [];
        const indent = getIndentation(lineText);
        let j = i + 1;
        while (j < lines.length) {
          const nextLine = lines[j];
          if (!nextLine.trim()) {
            break;
          }
          const nextIndent = getIndentation(nextLine);
          if (nextIndent <= indent) {
            break;
          }

          const subTaskMatch = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(nextLine);
          if (subTaskMatch) {
            const subParsed = parseTaskMetadata(subTaskMatch[2].trim());
            if (subParsed.text) {
              subitems.push({
                kind: "task",
                text: subParsed.text,
                completed: subTaskMatch[1].toLowerCase() === "x"
              });
            }
            j += 1;
            continue;
          }

          const bulletMatch = /^\s*[-*]\s+(.*)$/.exec(nextLine);
          if (bulletMatch) {
            const bulletText = bulletMatch[1].trim();
            if (bulletText) {
              subitems.push({ kind: "note", text: bulletText });
            }
            j += 1;
            continue;
          }

          const noteText = nextLine.trim();
          if (noteText) {
            subitems.push({ kind: "note", text: noteText });
          }
          j += 1;
        }

        if (j > i + 1) {
          i = j - 1;
        }

        tasks.push({
          file,
          line: i + 1,
          text: parsed.text,
          completed: match[1].toLowerCase() === "x",
          project: parsed.project,
          context: parsed.context,
          planned: parsed.planned,
          due: parsed.due,
          review: parsed.review,
          tags: parsed.tags,
          subitems
        });
      }
    }

    this.tasks = tasks;
    this.onChange?.();
  }
}

class FocusTasksView extends ItemView {
  private index: TaskIndex;
  private plugin: FocusTasksPlugin;
  private showCompleted = false;
  private listEl?: HTMLElement;
  private selectedSection:
    | "inbox"
    | "today"
    | "projects"
    | "review"
    | "tags"
    | "contexts"
    | "forecast" = "inbox";
  private sectionExpanded = new Map<string, boolean>();
  private expandedTasks = new Set<string>();
  private selectedTags = new Set<string>();

  constructor(leaf: WorkspaceLeaf, index: TaskIndex, plugin: FocusTasksPlugin) {
    super(leaf);
    this.index = index;
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return "FocusTasks";
  }

  async onOpen(): Promise<void> {
    this.containerEl.addClass("focus-tasks-view");
    this.renderView();
    this.index.onChange = () => this.renderView();
  }

  onClose(): void {
    this.index.onChange = undefined;
  }

  public renderView(): void {
    const { containerEl } = this;
    containerEl.empty();

    const header = containerEl.createDiv("focus-tasks-header");
    header.createEl("div", { text: "FocusTasks" }).addClass("focus-tasks-title");

    const toggleCompleted = header.createEl("button", {
      text: this.showCompleted ? "Dölj klara" : "Visa klara"
    });
    toggleCompleted.addEventListener("click", () => {
      this.showCompleted = !this.showCompleted;
      this.renderView();
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
      this.renderView();
    });

    const todayButton = sidebar.createEl("button", {
      text: "Today"
    });
    todayButton.addClass("focus-tasks-nav-item");
    todayButton.toggleClass("is-active", this.selectedSection === "today");
    todayButton.addEventListener("click", () => {
      this.selectedSection = "today";
      this.renderView();
    });

    const projectsButton = sidebar.createEl("button", {
      text: "Projekt"
    });
    projectsButton.addClass("focus-tasks-nav-item");
    projectsButton.toggleClass("is-active", this.selectedSection === "projects");
    projectsButton.addEventListener("click", () => {
      this.selectedSection = "projects";
      this.renderView();
    });

    const reviewButton = sidebar.createEl("button", {
      text: "Review"
    });
    reviewButton.addClass("focus-tasks-nav-item");
    reviewButton.toggleClass("is-active", this.selectedSection === "review");
    reviewButton.addEventListener("click", () => {
      this.selectedSection = "review";
      this.renderView();
    });

    const tagsButton = sidebar.createEl("button", {
      text: "Taggar"
    });
    tagsButton.addClass("focus-tasks-nav-item");
    tagsButton.toggleClass("is-active", this.selectedSection === "tags");
    tagsButton.addEventListener("click", () => {
      this.selectedSection = "tags";
      this.renderView();
    });

    const contextsButton = sidebar.createEl("button", {
      text: "Kontext"
    });
    contextsButton.addClass("focus-tasks-nav-item");
    contextsButton.toggleClass("is-active", this.selectedSection === "contexts");
    contextsButton.addEventListener("click", () => {
      this.selectedSection = "contexts";
      this.renderView();
    });

    const forecastButton = sidebar.createEl("button", {
      text: "Forecast"
    });
    forecastButton.addClass("focus-tasks-nav-item");
    forecastButton.toggleClass("is-active", this.selectedSection === "forecast");
    forecastButton.addEventListener("click", () => {
      this.selectedSection = "forecast";
      this.renderView();
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

      const overview = content.createDiv("focus-tasks-project-overview");
      for (const [projectName, tasks] of projects) {
        const openCount = tasks.filter((task) => !task.completed).length;
        const nextAction = getNextAction(tasks);
        const lastReview = getLastReview(tasks);
        const sectionId = `focus-project-${slugify(projectName)}`;

        const card = overview.createDiv("focus-tasks-project-card");
        card.addEventListener("click", () => {
          const target = content.querySelector(`#${sectionId}`);
          target?.scrollIntoView({ behavior: "smooth", block: "start" });
        });
        card.createEl("div", { text: projectName }).addClass("focus-tasks-project-name");
        card.createEl("div", { text: `${openCount} öppna` }).addClass("focus-tasks-project-count");

        if (nextAction) {
          card
            .createEl("div", { text: `Nästa: ${nextAction}` })
            .addClass("focus-tasks-project-next");
        }

        if (lastReview) {
          card
            .createEl("div", { text: `Senast review: ${lastReview}` })
            .addClass("focus-tasks-project-review");
        }
      }

      for (const [projectName, tasks] of projects) {
        const sorted = sortTasksByDate(tasks);
        this.renderSection(
          content,
          projectName,
          sorted,
          `project:${projectName}`,
          `focus-project-${slugify(projectName)}`
        );
      }
      return;
    }

    if (this.selectedSection === "review") {
      this.listEl = content.createDiv("focus-tasks-list");
      const cutoff = getLocalDateString(-7);
      const tasks = this.index.tasks.filter((task) => {
        if (!this.showCompleted && task.completed) {
          return false;
        }
        const reviewDate = parseDate(task.review);
        if (!reviewDate) {
          return true;
        }
        return reviewDate <= cutoff;
      });

      if (tasks.length === 0) {
        this.listEl.createEl("div", { text: "Inga uppgifter för review." });
        return;
      }

      for (const task of tasks) {
        this.renderTaskRow(task, this.listEl, true);
      }
      return;
    }

    if (this.selectedSection === "tags") {
      const tagSummary = getTagSummary(this.index.tasks, !this.showCompleted);
      const filterBar = content.createDiv("focus-tasks-tag-filter");
      filterBar.createEl("div", { text: "Filter" }).addClass("focus-tasks-tag-title");

      const selector = filterBar.createDiv("focus-tasks-tag-selector");
      const inputId = `focus-tags-input-${Date.now()}`;
      const datalistId = `focus-tags-list-${Date.now()}`;

      const input = selector.createEl("input", {
        type: "text",
        attr: { placeholder: "Välj tagg", list: datalistId, id: inputId }
      });
      input.addClass("focus-tasks-tag-input");

      const datalist = selector.createEl("datalist", { attr: { id: datalistId } });
      for (const tag of tagSummary) {
        datalist.createEl("option", { attr: { value: tag.name } });
      }

      const addTag = (value: string): void => {
        const tag = normalizeTag(value);
        if (!tag) {
          input.value = "";
          return;
        }
        if (this.selectedTags.has(tag)) {
          input.value = "";
          return;
        }
        this.selectedTags.add(tag);
        input.value = "";
        this.renderView();
      };

      input.addEventListener("change", () => {
        addTag(input.value);
      });
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          addTag(input.value);
        }
      });

      const selectedWrap = filterBar.createDiv("focus-tasks-tag-selected");
      for (const tag of Array.from(this.selectedTags)) {
        const chip = selectedWrap.createEl("button", { text: tag });
        chip.addClass("focus-tasks-tag-chip");
        chip.addEventListener("click", () => {
          this.selectedTags.delete(tag);
          input.value = "";
          this.renderView();
        });
      }

      const clearButton = filterBar.createEl("button", {
        text: "Rensa"
      });
      clearButton.addClass("focus-tasks-tag-clear");
      clearButton.addEventListener("click", () => {
        this.selectedTags.clear();
        this.renderView();
      });

      if (tagSummary.length === 0) {
        filterBar.createEl("div", { text: "Inga taggar." });
      }

      this.listEl = content.createDiv("focus-tasks-list");
      const tasks = this.index.tasks.filter((task) => {
        if (!this.showCompleted && task.completed) {
          return false;
        }
        if (task.tags.length === 0) {
          return false;
        }
        if (this.selectedTags.size === 0) {
          return false;
        }
        return Array.from(this.selectedTags).every((tag) =>
          task.tags.includes(tag)
        );
      });

      if (tasks.length === 0) {
        this.listEl.createEl("div", { text: "Inga uppgifter matchar." });
        return;
      }

      for (const task of tasks) {
        this.renderTaskRow(task, this.listEl);
      }
      return;
    }

    if (this.selectedSection === "contexts") {
      const contexts = groupTasksByContext(this.index.tasks, !this.showCompleted);
      if (contexts.size === 0) {
        content.createEl("div", { text: "Inga kontexter ännu." });
        return;
      }

      for (const [contextName, tasks] of contexts) {
        const sorted = sortTasksByDate(tasks);
        this.renderSection(
          content,
          contextName,
          sorted,
          `context:${contextName}`
        );
      }
      return;
    }

    if (this.selectedSection === "forecast") {
      const today = getLocalDateString();
      const days = 7;
      const forecast = buildForecastMap(
        this.index.tasks,
        today,
        days,
        !this.showCompleted
      );

      const overdue = this.index.tasks.filter((task) =>
        isTaskOverdue(task, today)
      );
      this.renderSection(content, "Överfört", overdue, "forecast-overdue");

      const todayEvents = filterEventsForDate(
        this.plugin.getEventsForDate(today),
        today
      );
      if (todayEvents.length > 0) {
        this.renderEventList(content, "Kalender idag", todayEvents);
      }

      for (let offset = 0; offset < days; offset += 1) {
        const date = getLocalDateString(offset);
        const tasks = forecast.get(date) ?? [];
        const events = filterEventsForDate(
          this.plugin.getEventsForDate(date),
          date
        );
        this.renderSection(
          content,
          formatForecastTitle(date, offset),
          tasks,
          `forecast-${date}`,
          undefined,
          events
        );
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

    const todayEvents = filterEventsForDate(
      this.plugin.getEventsForDate(today),
      today
    );
    if (todayEvents.length > 0) {
      this.renderEventList(content, "Kalender idag", todayEvents);
    }

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
    key: string,
    sectionId?: string,
    events?: CalendarEvent[]
  ): void {
    const section = container.createDiv("focus-tasks-section");
    if (sectionId) {
      section.setAttribute("id", sectionId);
    }
    const header = section.createDiv("focus-tasks-section-header");
    header.createEl("span", { text: title });

    const isExpanded = this.sectionExpanded.get(key) ?? true;
    const toggle = header.createEl("button", {
      text: isExpanded ? "Dölj" : "Visa"
    });
    toggle.addClass("focus-tasks-section-toggle");
    toggle.addEventListener("click", () => {
      this.sectionExpanded.set(key, !isExpanded);
      this.renderView();
    });

    if (!isExpanded) {
      return;
    }

    if (events && events.length > 0) {
      this.renderEventList(section, "Kalender", events);
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

  private renderTaskRow(
    task: TaskItem,
    container: HTMLElement,
    showReviewButton = false
  ): void {
    const taskKey = `${task.file.path}:${task.line}`;
    const row = container.createDiv("focus-tasks-item");
    row.toggleClass("is-complete", task.completed);
    row.toggleClass("is-collapsed", !this.expandedTasks.has(taskKey));
    row.toggleClass("is-overdue", isTaskOverdue(task, getLocalDateString()));

    const checkboxInput = row.createEl("input", {
      type: "checkbox",
    });
    checkboxInput.checked = task.completed;
    checkboxInput.addEventListener("change", () => {
      updateTaskInFile(this.app, task, {
        completed: checkboxInput.checked
      })
        .then(() => this.index.triggerRefresh())
        .catch(console.error);
    });

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

    if (showReviewButton) {
      const reviewedButton = noteRow.createEl("button", { text: "Reviewed" });
      reviewedButton.addClass("focus-tasks-reviewed");
      reviewedButton.addEventListener("click", () => {
        updateTaskInFile(this.app, task, {
          review: getLocalDateString()
        })
          .then(() => this.index.triggerRefresh())
          .catch(console.error);
      });
    }

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

    if (task.review) {
      const reviewWrap = metaRow.createDiv("focus-tasks-date");
      reviewWrap.createEl("span", { text: "Review" });
      reviewWrap.createEl("span", { text: task.review });
    }

    if (task.tags.length > 0) {
      const tagsWrap = metaRow.createDiv("focus-tasks-tags");
      for (const tag of task.tags) {
        const tagEl = tagsWrap.createEl("span", { text: tag });
        tagEl.addClass("focus-tasks-tag");
      }
    }

    if (task.subitems.length > 0) {
      const subitemsWrap = details.createDiv("focus-tasks-subitems");
      for (const item of task.subitems) {
        const subRow = subitemsWrap.createDiv("focus-tasks-subitem");
        if (item.kind === "task") {
          subRow.createEl("input", {
            type: "checkbox",
            attr: { disabled: "true" }
          }).checked = item.completed ?? false;
          subRow.createEl("span", { text: item.text });
        } else {
          subRow.createEl("span", { text: "•" }).addClass("focus-tasks-subitem-bullet");
          subRow.createEl("span", { text: item.text });
        }
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
      this.renderView();
    });
  }

  private renderEventList(
    container: HTMLElement,
    title: string,
    events: CalendarEvent[]
  ): void {
    const wrapper = container.createDiv("focus-tasks-events");
    const header = wrapper.createDiv("focus-tasks-events-header");
    header.createEl("span", { text: title });

    const list = wrapper.createDiv("focus-tasks-events-list");
    for (const event of events) {
      const row = list.createDiv("focus-tasks-event");
      const timeLabel = event.allDay
        ? "Heldag"
        : event.startTime && event.endTime
        ? `${event.startTime} - ${event.endTime}`
        : event.startTime ?? "";
      const calendarLabel = event.calendarName
        ? ` (${event.calendarName})`
        : "";
      row.createEl("span", { text: timeLabel }).addClass("focus-tasks-event-time");
      row
        .createEl("span", { text: `${event.title}${calendarLabel} (${event.date})` })
        .addClass("focus-tasks-event-title");
      if (event.location) {
        row.createEl("span", { text: event.location }).addClass("focus-tasks-event-location");
      }
    }
  }
}

export default class FocusTasksPlugin extends Plugin {
  private index!: TaskIndex;
  public settings: FocusTasksSettings = DEFAULT_SETTINGS;
  private calendarEvents = new Map<string, CalendarEvent[]>();
  private calendarInterval?: number;
  private calendarLastRefresh?: string;
  private calendarLastError?: string;
  private calendarSuccessCount = 0;
  private calendarFailCount = 0;
  private calendarEventCount = 0;

  async onload(): Promise<void> {
    this.index = new TaskIndex(this.app);
    await this.loadSettings();

    this.registerView(VIEW_TYPE, (leaf) =>
      new FocusTasksView(leaf, this.index, this)
    );

    this.addSettingTab(new FocusTasksSettingTab(this.app, this));

    this.addRibbonIcon("check-square", "FocusTasks", () => {
      this.activateView().catch(console.error);
    });

    this.addCommand({
      id: "focus-tasks-open",
      name: "Open FocusTasks",
      callback: () => this.activateView()
    });

    this.addCommand({
      id: "focus-tasks-edit-task",
      name: "Edit task metadata",
      editorCallback: (editor) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
          new Notice("Ingen fil är öppen.");
          return;
        }
        const cursorLine = editor.getCursor().line;
        const targetLine = findNearestTaskLine(editor, cursorLine);
        if (targetLine === undefined) {
          new Notice("Ingen uppgift hittades på raden.");
          return;
        }
        const taskText = editor.getLine(targetLine).trim();
        const modal = new TaskEditModal(
          this.app,
          file,
          targetLine + 1,
          taskText,
          () => this.index.triggerRefresh()
        );
        modal.open();
      }
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
    await this.refreshCalendars();
    this.calendarInterval = window.setInterval(
      () => this.refreshCalendars(),
      5 * 60 * 1000
    );
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
    if (this.calendarInterval) {
      window.clearInterval(this.calendarInterval);
    }
  }

  getEventsForDate(date: string): CalendarEvent[] {
    return this.calendarEvents.get(date) ?? [];
  }

  getCalendarStatus(): { lastRefresh?: string; lastError?: string } {
    return {
      lastRefresh: this.calendarLastRefresh,
      lastError: this.calendarLastError
    };
  }

  getCalendarStats(): { success: number; failed: number } {
    return {
      success: this.calendarSuccessCount,
      failed: this.calendarFailCount
    };
  }

  getCalendarEventCount(): number {
    return this.calendarEventCount;
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<FocusTasksSettings> & {
      calendarUrls?: string[];
    };

    const sources = data.calendarSources ??
      (data.calendarUrls
        ? data.calendarUrls.map((url) => ({ name: "", url }))
        : undefined);

    this.settings = {
      calendarSources: sources ?? DEFAULT_SETTINGS.calendarSources,
      calendarRangeDays:
        data.calendarRangeDays ?? DEFAULT_SETTINGS.calendarRangeDays
    };

    if (this.settings.calendarSources.length < 10) {
      this.settings.calendarSources = this.settings.calendarSources.concat(
        Array.from({ length: 10 - this.settings.calendarSources.length }, () => ({
          name: "",
          url: ""
        }))
      );
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    await this.refreshCalendars();
  }

  async refreshCalendars(): Promise<void> {
    const sources = this.settings.calendarSources.filter((source) =>
      source.url.trim()
    );
    const events = new Map<string, CalendarEvent[]>();
    const rangeStart = getLocalDateString();
    const rangeEnd = getLocalDateString(
      Math.max(1, Math.min(60, this.settings.calendarRangeDays))
    );
    this.calendarLastError = undefined;
    this.calendarSuccessCount = 0;
    this.calendarFailCount = 0;
    this.calendarEventCount = 0;

    for (const source of sources) {
      try {
        const normalizedUrl = normalizeCalendarUrl(source.url);
        const response = await requestUrl({
          url: normalizedUrl,
          headers: { "User-Agent": "FocusTasks" }
        });
        const calendarName = source.name || getCalendarNameFromUrl(source.url);
        const parsed = parseIcsEvents(
          response.text ?? "",
          rangeStart,
          rangeEnd,
          calendarName
        );
        for (const event of parsed) {
          const list = events.get(event.date) ?? [];
          list.push(event);
          events.set(event.date, list);
        }
        this.calendarEventCount += parsed.length;
        this.calendarSuccessCount += 1;
      } catch (error) {
        console.error("Calendar fetch failed", error);
        this.calendarFailCount += 1;
        const message =
          error instanceof Error ? error.message : "Okänt fel";
        this.calendarLastError = `Kunde inte läsa kalender: ${message}`;
      }
    }

    for (const [date, list] of events) {
      events.set(
        date,
        list.sort((a, b) => (a.startTime ?? "").localeCompare(b.startTime ?? ""))
      );
    }

    this.calendarEvents = events;
    this.calendarLastRefresh = new Date().toLocaleString();
    this.refreshViews();
  }

  private refreshViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const view = leaf.view as FocusTasksView;
      view.renderView();
    }
  }

  async debugCalendars(): Promise<void> {
    const sources = this.settings.calendarSources.filter((source) =>
      source.url.trim()
    );
    if (sources.length === 0) {
      new Notice("Ingen kalender-URL angiven.");
      return;
    }

    const summaries: string[] = [];
    for (const source of sources) {
      try {
        const normalizedUrl = normalizeCalendarUrl(source.url);
        const response = await requestUrl({ url: normalizedUrl });
        const text = response.text ?? "";
        const vevents = (text.match(/BEGIN:VEVENT/g) || []).length;
        const dtstarts = text.match(/DTSTART[^\n]*/g) || [];
        const sample = dtstarts.slice(0, 5).join(" | ");
        const has2026 = dtstarts.some((line) => line.includes("2026"));
        summaries.push(
          `${source.name || normalizedUrl}: VEVENT=${vevents}, DTSTART=${dtstarts.length}, 2026=${has2026 ? "ja" : "nej"}`
        );
        if (sample) {
          summaries.push(`Sample: ${sample}`);
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Okänt fel";
        summaries.push(`${source.name || source.url}: FEL ${message}`);
      }
    }

    new Notice(summaries.join("\n"), 10000);
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

class FocusTasksSettingTab extends PluginSettingTab {
  private plugin: FocusTasksPlugin;

  constructor(app: App, plugin: FocusTasksPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h3", { text: "Kalendrar" });
    containerEl.createEl("p", {
      text: "Fyll i upp till 10 ICS‑URLer. Lämna tomt för att inaktivera."
    });

    new Setting(containerEl)
      .setName("Antal dagar framåt")
      .setDesc("Hur många dagar i framtiden kalendern ska visa (1–60)")
      .addText((text) =>
        text
          .setPlaceholder("7")
          .setValue(String(this.plugin.settings.calendarRangeDays))
          .onChange(async (newValue) => {
            const parsed = Number.parseInt(newValue, 10);
            this.plugin.settings.calendarRangeDays = Number.isNaN(parsed)
              ? DEFAULT_SETTINGS.calendarRangeDays
              : Math.max(1, Math.min(60, parsed));
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Testa kalendrar")
      .setDesc("Visar en snabb summering av ICS‑innehåll")
      .addButton((button) =>
        button.setButtonText("Kör test").onClick(async () => {
          await this.plugin.debugCalendars();
        })
      );

    const status = this.plugin.getCalendarStatus();
    const statusText = status.lastRefresh
      ? `Senast uppdaterad: ${status.lastRefresh}`
      : "Ingen uppdatering ännu.";
    containerEl.createEl("p", { text: statusText });
    const stats = this.plugin.getCalendarStats();
    containerEl.createEl("p", {
      text: `Lyckade: ${stats.success} • Misslyckade: ${stats.failed}`
    });
    containerEl.createEl("p", {
      text: `Events hittade: ${this.plugin.getCalendarEventCount()}`
    });
    containerEl.createEl("p", {
      text: `Range: ${this.plugin.settings.calendarRangeDays} dagar`
    });
    if (status.lastError) {
      containerEl.createEl("p", { text: status.lastError });
    }

    this.plugin.settings.calendarSources.forEach((source, index) => {
      const setting = new Setting(containerEl).setName(`Kalender ${index + 1}`);
      setting.addText((text) =>
        text
          .setPlaceholder("Namn")
          .setValue(source.name)
          .onChange(async (newValue) => {
            this.plugin.settings.calendarSources[index].name = newValue.trim();
            await this.plugin.saveSettings();
          })
      );
      setting.addText((text) =>
        text
          .setPlaceholder("ICS URL")
          .setValue(source.url)
          .onChange(async (newValue) => {
            this.plugin.settings.calendarSources[index].url = newValue.trim();
            await this.plugin.saveSettings();
          })
      );
    });
  }
}

class TaskEditModal extends Modal {
  private file: TFile;
  private line: number;
  private taskText?: string;
  private onSave?: () => void;

  constructor(
    app: App,
    file: TFile,
    line: number,
    taskText?: string,
    onSave?: () => void
  ) {
    super(app);
    this.file = file;
    this.line = line;
    this.taskText = taskText;
    this.onSave = onSave;
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Uppgift" });

    const taskData = await this.loadTaskData();
    if (!taskData) {
      contentEl.createEl("p", { text: "Kunde inte läsa uppgiften." });
      return;
    }

    const { task } = taskData;

    const titleInput = contentEl.createEl("input", {
      type: "text",
      value: task.text,
      attr: { placeholder: "Titel" }
    });
    titleInput.addClass("focus-tasks-modal-input");

    const projectInput = contentEl.createEl("input", {
      type: "text",
      value: task.project ?? "",
      attr: { placeholder: "Project" }
    });
    projectInput.addClass("focus-tasks-modal-input");

    const contextInput = contentEl.createEl("input", {
      type: "text",
      value: task.context ?? "",
      attr: { placeholder: "Kontext" }
    });
    contextInput.addClass("focus-tasks-modal-input");

    const plannedInput = contentEl.createEl("input", {
      type: "date",
      value: task.planned ?? ""
    });
    plannedInput.addClass("focus-tasks-modal-input");

    const dueInput = contentEl.createEl("input", {
      type: "date",
      value: task.due ?? ""
    });
    dueInput.addClass("focus-tasks-modal-input");

    const reviewInput = contentEl.createEl("input", {
      type: "date",
      value: task.review ?? ""
    });
    reviewInput.addClass("focus-tasks-modal-input");

    const tagsInput = contentEl.createEl("input", {
      type: "text",
      value: task.tags.join(", "),
      attr: { placeholder: "Taggar (komma-separerat)" }
    });
    tagsInput.addClass("focus-tasks-modal-input");

    const saveButton = contentEl.createEl("button", { text: "Spara" });
    saveButton.addClass("focus-tasks-modal-save");
    saveButton.addEventListener("click", async () => {
      const tags = normalizeTagList(tagsInput.value);
      await updateTaskInFile(this.app, taskData.taskRef, {
        text: titleInput.value.trim() || task.text,
        project: projectInput.value.trim() || undefined,
        context: contextInput.value.trim() || undefined,
        planned: plannedInput.value || undefined,
        due: dueInput.value || undefined,
        review: reviewInput.value || undefined,
        tags
      });
      this.onSave?.();
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async loadTaskData(): Promise<
    | { task: TaskItem; taskRef: TaskItem }
    | undefined
  > {
    const content = await this.app.vault.read(this.file);
    const lines = content.split(/\r?\n/);
    const baseIndex = this.line - 1;
    if (baseIndex < 0 || baseIndex >= lines.length) {
      return undefined;
    }

    let match: RegExpExecArray | null = null;
    let index = baseIndex;
    const range = 20;
    for (let offset = 0; offset <= range; offset += 1) {
      const forward = baseIndex + offset;
      if (forward >= 0 && forward < lines.length) {
        const forwardMatch = /^(\s*[-*])\s+\[( |x|X)\]\s+(.*)$/.exec(
          lines[forward]
        );
        if (forwardMatch) {
          match = forwardMatch;
          index = forward;
          break;
        }
      }
      const backward = baseIndex - offset;
      if (backward >= 0 && backward < lines.length) {
        const backwardMatch = /^(\s*[-*])\s+\[( |x|X)\]\s+(.*)$/.exec(
          lines[backward]
        );
        if (backwardMatch) {
          match = backwardMatch;
          index = backward;
          break;
        }
      }
    }

    if (!match) {
      if (this.taskText) {
        const target = normalizeTaskText(this.taskText);
        for (let i = 0; i < lines.length; i += 1) {
          const candidate = /^(\s*[-*])\s+\[( |x|X)\]\s+(.*)$/.exec(
            lines[i]
          );
          if (!candidate) {
            continue;
          }
          const parsed = parseTaskMetadata(candidate[3].trim());
          if (normalizeTaskText(parsed.text) === target) {
            match = candidate;
            index = i;
            break;
          }
        }
      }
    }

    if (!match) {
      return undefined;
    }
    const parsed = parseTaskMetadata(match[3].trim());
    const task: TaskItem = {
      file: this.file,
      line: index + 1,
      text: parsed.text,
      completed: match[2].toLowerCase() === "x",
      project: parsed.project,
      context: parsed.context,
      planned: parsed.planned,
      due: parsed.due,
      review: parsed.review,
      tags: parsed.tags,
      subitems: []
    };
    return { task, taskRef: task };
  }
}

function findNearestTaskLine(editor: any, startLine: number): number | undefined {
  const isTaskLine = (lineText: string): boolean =>
    /^\s*[-*]\s+\[( |x|X)\]\s+/.test(lineText);

  const current = editor.getLine(startLine);
  if (isTaskLine(current)) {
    return startLine;
  }

  for (let i = startLine - 1; i >= 0; i -= 1) {
    if (isTaskLine(editor.getLine(i))) {
      return i;
    }
    if (!editor.getLine(i).trim()) {
      break;
    }
  }

  return undefined;
}

function parseTaskMetadata(rawText: string): {
  text: string;
  project?: string;
  context?: string;
  planned?: string;
  due?: string;
  review?: string;
  tags: string[];
} {
  let text = rawText;
  let project: string | undefined;
  let context: string | undefined;
  let planned: string | undefined;
  let due: string | undefined;
  let review: string | undefined;

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

  const contextResult = extractMetadata(text, "context");
  if (contextResult.value) {
    context = normalizeContextName(contextResult.value);
    text = contextResult.text;
  } else {
    const contextAlt = extractMetadata(text, "område");
    context = contextAlt.value
      ? normalizeContextName(contextAlt.value)
      : undefined;
    text = contextAlt.text;
  }

  const plannedResult = extractMetadata(text, "planned");
  planned = plannedResult.value;
  text = plannedResult.text;

  const dueResult = extractMetadata(text, "due");
  due = dueResult.value;
  text = dueResult.text;

  const reviewResult = extractMetadata(text, "review");
  review = reviewResult.value;
  text = reviewResult.text;

  const tagResult = extractTags(text);
  text = tagResult.text;

  return {
    text: text.trim(),
    project,
    context,
    planned,
    due,
    review,
    tags: tagResult.tags
  };
}

function extractMetadata(
  text: string,
  key: "project" | "projekt" | "context" | "område" | "planned" | "due" | "review"
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
  if (key === "planned" || key === "due" || key === "review") {
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
  const unique = Array.from(new Set(tags.map((tag) => normalizeTag(tag))));
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

function normalizeContextName(value: string): string {
  return normalizeProjectName(value);
}

function normalizeTag(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const withHash = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  return withHash.toLowerCase();
}

function normalizeTagList(value: string): string[] {
  const parts = value
    .split(/[,\s]+/)
    .map((part) => normalizeTag(part))
    .filter((part) => part);
  return Array.from(new Set(parts));
}

function normalizeTaskText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function filterEventsForDate(
  events: CalendarEvent[],
  date: string
): CalendarEvent[] {
  return events.filter((event) => event.date === date);
}

function parseIcsEvents(
  ics: string,
  rangeStart?: string,
  rangeEnd?: string,
  calendarName?: string
): CalendarEvent[] {
  if (!ics.trim()) {
    return [];
  }
  const jcal = ICAL.parse(ics);
  const component = new ICAL.Component(jcal);
  registerTimezones(component);
  const events = component.getAllSubcomponents("vevent");
  const parsed: CalendarEvent[] = [];
  const startLimit = rangeStart;
  const endLimit = rangeEnd;
  const maxOccurrences = 2000;
  let occurrenceCount = 0;

  for (const vevent of events) {
    const event = new ICAL.Event(vevent);
    if (!event.startDate) {
      continue;
    }

    if (event.isRecurring()) {
      let iteratorStart = event.startDate.clone();
      if (startLimit) {
        const [year, month, day] = startLimit.split("-").map(Number);
        const eventStartDate = formatIcalDate(event.startDate);
        if (startLimit > eventStartDate) {
          iteratorStart.year = year;
          iteratorStart.month = month;
          iteratorStart.day = day;
        }
      }
      const iterator = event.iterator(iteratorStart);
      let next = iterator.next();
      while (next) {
        if (occurrenceCount >= maxOccurrences) {
          break;
        }
        const occurrence = event.getOccurrenceDetails(next);
        const occDate = formatIcalDate(occurrence.startDate);
        if (startLimit && occDate < startLimit) {
          next = iterator.next();
          continue;
        }
        if (endLimit && occDate > endLimit) {
          break;
        }
        parsed.push(
          ...buildEventEntries(
            event,
            occurrence.startDate,
            occurrence.endDate,
            calendarName
          )
        );
        occurrenceCount += 1;
        next = iterator.next();
      }
      continue;
    }

    const singleDate = formatIcalDate(event.startDate);
    if (startLimit && singleDate < startLimit) {
      continue;
    }
    if (endLimit && singleDate > endLimit) {
      continue;
    }
    parsed.push(
      ...buildEventEntries(event, event.startDate, event.endDate, calendarName)
    );
    occurrenceCount += 1;
  }

  return parsed;
}

function buildEventEntries(
  event: ICAL.Event,
  start: ICAL.Time,
  end?: ICAL.Time,
  calendarName?: string
): CalendarEvent[] {
  const allDay = start.isDate;
  const startDate = formatIcalDate(start);
  const endDate = end ? formatIcalDate(end) : startDate;
  const endDateAdjusted = allDay ? adjustDate(endDate, -1) : endDate;
  const dates = allDay ? enumerateDates(startDate, endDateAdjusted) : [startDate];
  const startTime = allDay ? undefined : formatIcalTime(start);
  const endTime = allDay ? undefined : (end ? formatIcalTime(end) : undefined);

  return dates.map((date) => ({
    title: event.summary || "(Untitled)",
    date,
    allDay,
    startTime,
    endTime,
    location: event.location || undefined,
    calendarName
  }));
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatIcalDate(time: ICAL.Time): string {
  const year = time.year;
  const month = String(time.month).padStart(2, "0");
  const day = String(time.day).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatIcalTime(time: ICAL.Time): string {
  const jsDate = time.toJSDate();
  const tzid = time.zone?.tzid;
  if (tzid && tzid !== "floating") {
    return new Intl.DateTimeFormat([], {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: tzid
    }).format(jsDate);
  }
  return new Intl.DateTimeFormat([], {
    hour: "2-digit",
    minute: "2-digit"
  }).format(jsDate);
}

function adjustDate(date: string, offsetDays: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const adjusted = new Date(year, month - 1, day + offsetDays);
  return formatDate(adjusted);
}

function registerTimezones(component: ICAL.Component): void {
  const timezones = component.getAllSubcomponents("vtimezone");
  for (const timezone of timezones) {
    try {
      ICAL.TimezoneService.register(timezone);
    } catch (error) {
      console.warn("Timezone register failed", error);
    }
  }
}

function startOfDay(date: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day, 0, 0, 0, 0);
}

function endOfDay(date: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day, 23, 59, 59, 999);
}

function normalizeCalendarUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed.startsWith("webcal://")) {
    return `https://${trimmed.slice("webcal://".length)}`;
  }
  return trimmed;
}

function getCalendarNameFromUrl(url: string): string {
  try {
    const normalized = normalizeCalendarUrl(url);
    const parsed = new URL(normalized);
    return parsed.hostname;
  } catch {
    return "Kalender";
  }
}

function getIndentation(line: string): number {
  const match = /^\s*/.exec(line);
  return match ? match[0].length : 0;
}

function parseDate(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = normalizeDateString(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : undefined;
}

function isTaskOverdue(task: TaskItem, today: string): boolean {
  if (task.completed) {
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

function buildForecastMap(
  tasks: TaskItem[],
  startDate: string,
  days: number,
  hideCompleted: boolean
): Map<string, TaskItem[]> {
  const map = new Map<string, TaskItem[]>();
  for (let offset = 0; offset < days; offset += 1) {
    map.set(getLocalDateString(offset), []);
  }

  for (const task of tasks) {
    if (hideCompleted && task.completed) {
      continue;
    }
    const plannedDate = parseDate(task.planned);
    const dueDate = parseDate(task.due);

    if (plannedDate && dueDate) {
      const dates = enumerateDates(plannedDate, dueDate);
      for (const date of dates) {
        if (map.has(date)) {
          map.get(date)!.push(task);
        }
      }
      continue;
    }

    if (plannedDate) {
      if (map.has(plannedDate)) {
        map.get(plannedDate)!.push(task);
      }
      continue;
    }

    if (dueDate) {
      if (map.has(dueDate)) {
        map.get(dueDate)!.push(task);
      }
    }
  }

  for (const [date, items] of map) {
    map.set(date, sortTasksByDate(items));
  }

  return map;
}

function enumerateDates(start: string, end: string): string[] {
  if (start > end) {
    return [];
  }
  const dates: string[] = [];
  const current = new Date(start);
  const last = new Date(end);
  while (current <= last) {
    const year = current.getFullYear();
    const month = String(current.getMonth() + 1).padStart(2, "0");
    const day = String(current.getDate()).padStart(2, "0");
    dates.push(`${year}-${month}-${day}`);
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

function formatForecastTitle(date: string, offset: number): string {
  if (offset === 0) {
    return `Idag (${date})`;
  }
  if (offset === 1) {
    return `Imorgon (${date})`;
  }
  return date;
}

function getNextAction(tasks: TaskItem[]): string | undefined {
  const openTasks = tasks.filter((task) => !task.completed);
  if (openTasks.length === 0) {
    return undefined;
  }
  const sorted = sortTasksByDate(openTasks);
  return sorted[0]?.text;
}

function getLastReview(tasks: TaskItem[]): string | undefined {
  const reviews = tasks
    .map((task) => parseDate(task.review))
    .filter((value): value is string => !!value)
    .sort((a, b) => b.localeCompare(a));
  return reviews[0];
}

function getTagSummary(
  tasks: TaskItem[],
  hideCompleted: boolean
): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    if (hideCompleted && task.completed) {
      continue;
    }
    for (const tag of task.tags) {
      const normalized = normalizeTag(tag);
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function groupTasksByContext(
  tasks: TaskItem[],
  hideCompleted: boolean
): Map<string, TaskItem[]> {
  const result = new Map<string, TaskItem[]>();
  for (const task of tasks) {
    if (hideCompleted && task.completed) {
      continue;
    }
    if (!task.context) {
      continue;
    }
    const existing = result.get(task.context) ?? [];
    existing.push(task);
    result.set(task.context, existing);
  }
  return new Map(
    Array.from(result.entries()).sort(([a], [b]) => a.localeCompare(b))
  );
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}


async function updateTaskInFile(
  app: App,
  task: TaskItem,
  updates: {
    text?: string;
    project?: string;
    context?: string;
    planned?: string;
    due?: string;
    review?: string;
    completed?: boolean;
    tags?: string[];
  }
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
  const context = updates.context ?? current.context;
  const planned = updates.planned ?? current.planned;
  const due = updates.due ?? current.due;
  const review = updates.review ?? current.review;
  const completed = updates.completed ?? task.completed;
  const tagsList = updates.tags ?? current.tags;

  const metaParts: string[] = [];
  const projectKey = /(?:^|\s)projekt::/i.test(match[3])
    ? "projekt"
    : "project";
  if (project) {
    metaParts.push(`${projectKey}:: ${project}`);
  }
  const contextKey = /(?:^|\s)område::/i.test(match[3])
    ? "område"
    : "context";
  if (context) {
    metaParts.push(`${contextKey}:: ${context}`);
  }
  if (planned) {
    metaParts.push(`planned:: ${planned}`);
  }
  if (due) {
    metaParts.push(`due:: ${due}`);
  }
  if (review) {
    metaParts.push(`review:: ${review}`);
  }

  const tags = tagsList.length > 0 ? ` ${tagsList.join(" ")}` : "";

  const meta = metaParts.length > 0 ? ` ${metaParts.join(" ")}` : "";
  const checkboxValue = completed ? "x" : " ";
  lines[index] = `${bullet} [${checkboxValue}] ${text}${meta}${tags}`.trimEnd();

  await app.vault.modify(task.file, lines.join("\n"));
}
