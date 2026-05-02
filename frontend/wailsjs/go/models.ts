export namespace cluster {
	
	export class Prerequisites {
	    docker: boolean;
	    dockerErr?: string;
	    kind: boolean;
	    kindErr?: string;
	    kubectl: boolean;
	    kubectlErr?: string;
	
	    static createFrom(source: any = {}) {
	        return new Prerequisites(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.docker = source["docker"];
	        this.dockerErr = source["dockerErr"];
	        this.kind = source["kind"];
	        this.kindErr = source["kindErr"];
	        this.kubectl = source["kubectl"];
	        this.kubectlErr = source["kubectlErr"];
	    }
	}

}

export namespace exam {
	
	export class QuestionStatus {
	    attempted: boolean;
	    passed: boolean;
	
	    static createFrom(source: any = {}) {
	        return new QuestionStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.attempted = source["attempted"];
	        this.passed = source["passed"];
	    }
	}
	export class StatusResponse {
	    started: boolean;
	    finished: boolean;
	    timeRemaining: number;
	    questions: Record<string, QuestionStatus>;
	
	    static createFrom(source: any = {}) {
	        return new StatusResponse(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.started = source["started"];
	        this.finished = source["finished"];
	        this.timeRemaining = source["timeRemaining"];
	        this.questions = this.convertValues(source["questions"], QuestionStatus, true);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

export namespace question {
	
	export class ClusterConfig {
	    name: string;
	    nodes: number;
	    workers: number;
	    controlPlane: number;
	
	    static createFrom(source: any = {}) {
	        return new ClusterConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.nodes = source["nodes"];
	        this.workers = source["workers"];
	        this.controlPlane = source["controlPlane"];
	    }
	}
	export class DeckSubtopic {
	    id: string;
	    title: string;
	    summary?: string;
	    content: string;
	    tags?: string[];
	
	    static createFrom(source: any = {}) {
	        return new DeckSubtopic(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.title = source["title"];
	        this.summary = source["summary"];
	        this.content = source["content"];
	        this.tags = source["tags"];
	    }
	}
	export class DeckTopic {
	    id: string;
	    title: string;
	    description: string;
	    component?: string;
	    domain?: string;
	    tags?: string[];
	    subtopics: DeckSubtopic[];
	    subtopicCount: number;
	
	    static createFrom(source: any = {}) {
	        return new DeckTopic(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.title = source["title"];
	        this.description = source["description"];
	        this.component = source["component"];
	        this.domain = source["domain"];
	        this.tags = source["tags"];
	        this.subtopics = this.convertValues(source["subtopics"], DeckSubtopic);
	        this.subtopicCount = source["subtopicCount"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class DeckTopicSummary {
	    id: string;
	    title: string;
	    description: string;
	    component?: string;
	    domain?: string;
	    tags?: string[];
	    subtopicCount: number;
	
	    static createFrom(source: any = {}) {
	        return new DeckTopicSummary(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.title = source["title"];
	        this.description = source["description"];
	        this.component = source["component"];
	        this.domain = source["domain"];
	        this.tags = source["tags"];
	        this.subtopicCount = source["subtopicCount"];
	    }
	}
	export class ExamSummary {
	    id: string;
	    name: string;
	    description: string;
	    duration: number;
	    difficulty: string;
	    passScore: number;
	    clusters: ClusterConfig[];
	    tags?: string[];
	    questionCount: number;
	    totalWeight: number;
	
	    static createFrom(source: any = {}) {
	        return new ExamSummary(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.description = source["description"];
	        this.duration = source["duration"];
	        this.difficulty = source["difficulty"];
	        this.passScore = source["passScore"];
	        this.clusters = this.convertValues(source["clusters"], ClusterConfig);
	        this.tags = source["tags"];
	        this.questionCount = source["questionCount"];
	        this.totalWeight = source["totalWeight"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class QuestionSummary {
	    id: string;
	    title: string;
	    category: string;
	    difficulty: string;
	    weight: number;
	
	    static createFrom(source: any = {}) {
	        return new QuestionSummary(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.title = source["title"];
	        this.category = source["category"];
	        this.difficulty = source["difficulty"];
	        this.weight = source["weight"];
	    }
	}
	export class ValidationResult {
	    description: string;
	    passed: boolean;
	    expected: string;
	    actual: string;
	
	    static createFrom(source: any = {}) {
	        return new ValidationResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.description = source["description"];
	        this.passed = source["passed"];
	        this.expected = source["expected"];
	        this.actual = source["actual"];
	    }
	}

}

export namespace service {
	
	export class CategoryScore {
	    category: string;
	    earned: number;
	    total: number;
	    score: number;
	
	    static createFrom(source: any = {}) {
	        return new CategoryScore(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.category = source["category"];
	        this.earned = source["earned"];
	        this.total = source["total"];
	        this.score = source["score"];
	    }
	}
	export class QuestionResultDetail {
	    id: string;
	    title: string;
	    category: string;
	    difficulty: string;
	    weight: number;
	    context: string;
	    task: string;
	    hint?: string;
	    solution?: string;
	    attempted: boolean;
	    passed: boolean;
	
	    static createFrom(source: any = {}) {
	        return new QuestionResultDetail(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.title = source["title"];
	        this.category = source["category"];
	        this.difficulty = source["difficulty"];
	        this.weight = source["weight"];
	        this.context = source["context"];
	        this.task = source["task"];
	        this.hint = source["hint"];
	        this.solution = source["solution"];
	        this.attempted = source["attempted"];
	        this.passed = source["passed"];
	    }
	}
	export class AttemptRecord {
	    id: string;
	    examId: string;
	    examName: string;
	    date: string;
	    score: number;
	    earned: number;
	    total: number;
	    passScore: number;
	    passed: boolean;
	    duration: number;
	    questions: QuestionResultDetail[];
	    categories: CategoryScore[];
	
	    static createFrom(source: any = {}) {
	        return new AttemptRecord(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.examId = source["examId"];
	        this.examName = source["examName"];
	        this.date = source["date"];
	        this.score = source["score"];
	        this.earned = source["earned"];
	        this.total = source["total"];
	        this.passScore = source["passScore"];
	        this.passed = source["passed"];
	        this.duration = source["duration"];
	        this.questions = this.convertValues(source["questions"], QuestionResultDetail);
	        this.categories = this.convertValues(source["categories"], CategoryScore);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class AttemptSummary {
	    id: string;
	    examId: string;
	    examName: string;
	    date: string;
	    score: number;
	    passScore: number;
	    passed: boolean;
	    earned: number;
	    total: number;
	
	    static createFrom(source: any = {}) {
	        return new AttemptSummary(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.examId = source["examId"];
	        this.examName = source["examName"];
	        this.date = source["date"];
	        this.score = source["score"];
	        this.passScore = source["passScore"];
	        this.passed = source["passed"];
	        this.earned = source["earned"];
	        this.total = source["total"];
	    }
	}
	
	export class ClusterStatusResponse {
	    running: boolean;
	    healthy: boolean;
	    state: string;
	    nodes: string[];
	    name: string;
	
	    static createFrom(source: any = {}) {
	        return new ClusterStatusResponse(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.running = source["running"];
	        this.healthy = source["healthy"];
	        this.state = source["state"];
	        this.nodes = source["nodes"];
	        this.name = source["name"];
	    }
	}
	export class ExamResultResponse {
	    finished: boolean;
	    score: number;
	    total: number;
	    earned: number;
	    passScore: number;
	    questions: QuestionResultDetail[];
	    categories: CategoryScore[];
	
	    static createFrom(source: any = {}) {
	        return new ExamResultResponse(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.finished = source["finished"];
	        this.score = source["score"];
	        this.total = source["total"];
	        this.earned = source["earned"];
	        this.passScore = source["passScore"];
	        this.questions = this.convertValues(source["questions"], QuestionResultDetail);
	        this.categories = this.convertValues(source["categories"], CategoryScore);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class QuestionDetailResponse {
	    id: string;
	    title: string;
	    category: string;
	    difficulty: string;
	    weight: number;
	    context: string;
	    task: string;
	    guide?: string;
	    hint?: string;
	    solution?: string;
	
	    static createFrom(source: any = {}) {
	        return new QuestionDetailResponse(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.title = source["title"];
	        this.category = source["category"];
	        this.difficulty = source["difficulty"];
	        this.weight = source["weight"];
	        this.context = source["context"];
	        this.task = source["task"];
	        this.guide = source["guide"];
	        this.hint = source["hint"];
	        this.solution = source["solution"];
	    }
	}
	
	export class ValidationResponse {
	    questionId: string;
	    passed: boolean;
	    results: question.ValidationResult[];
	
	    static createFrom(source: any = {}) {
	        return new ValidationResponse(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.questionId = source["questionId"];
	        this.passed = source["passed"];
	        this.results = this.convertValues(source["results"], question.ValidationResult);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

