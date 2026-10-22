/**
 * 工具规格：给「支持 function calling 的模型」看的 JSON Schema（OpenAI tools 格式）。
 *
 * 为什么不从 zod 自动转：我们只有 10 个工具，手写一遍更可控，
 * 而且描述文案（什么时候用、参数怎么填）本来就是给模型看的提示词，值得单独打磨。
 *
 * 与 `tools.ts` 的 zod schema 是两份：zod 负责运行时校验（严），
 * JSON Schema 负责告诉模型怎么填（宽 + 带说明）。两者字段必须对齐，
 * `test/toolspec.test.ts` 会核对。
 */
import { TOOLS, type ToolName } from './tools';

export interface JsonSchemaProperty {
  type?: string;
  description?: string;
  enum?: string[];
  anyOf?: JsonSchemaProperty[];
  items?: JsonSchemaProperty;
  minimum?: number;
  maximum?: number;
  default?: unknown;
}

export interface ToolSpec {
  type: 'function';
  function: {
    name: ToolName;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, JsonSchemaProperty>;
      required?: string[];
      additionalProperties?: boolean;
    };
  };
}

const DAY: JsonSchemaProperty = {
  anyOf: [
    { type: 'string', enum: ['today', 'tomorrow'] },
    { type: 'integer', minimum: 1, maximum: 7 },
  ],
  description: '哪天：today / tomorrow，或 1-7（周一=1）。用户说「明天/后天」时优先用 today/tomorrow 语义，不要自己算成具体日期。',
};

const PERIOD: JsonSchemaProperty = {
  type: 'string',
  enum: ['morning', 'afternoon', 'evening'],
  description: '时段：morning 上午（1-4 节）/ afternoon 下午（5-8 节）/ evening 晚上（9-10 节）。用户说「上午/下午/晚上」时必须带上。',
};

export const TOOL_SPECS: ToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'get_schedule',
      description:
        '查这名学生自己的课表。可以整周、按天（今天/明天/周几）、按时段（上午/下午/晚上）查。' +
        '用户问「今天/明天有课吗」「下午有课吗」都用它，不要用空教室工具。',
      parameters: {
        type: 'object',
        properties: {
          week: { type: 'integer', minimum: 1, maximum: 30, description: '教学周次；不填=当前周' },
          day: DAY,
          period: PERIOD,
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_free_room',
      description:
        '查某天有哪些空教室/自习室可用（全校教室减去当天占用）。' +
        '用户问「哪里能自习」「明天下午哪间教室空着」「南核空教室」时用。',
      parameters: {
        type: 'object',
        properties: {
          date: {
            type: 'string',
            description: '日期 YYYY-MM-DD。**用户说今天/明天/后天时不要填这个字段**，交给服务端按相对日期算，模型自己算日期不可靠。',
          },
          campus: { type: 'string', description: '校区，例如 主校区 / 南校区 / 北校区' },
          building: {
            type: 'string',
            description:
              '地点原词，按教室名前缀过滤：南核 / 北核 / 核心教学区 / 北1 / 南2 / 物理馆 / 材料馆 / 化学馆 / 图书馆。' +
              '用户提到具体楼或教学区时，原样填他说的词。',
          },
          minSeats: { type: 'integer', minimum: 0, description: '最少座位数（多数教室没有座位数据，筛完可能变少）' },
          sections: {
            type: 'array',
            items: { type: 'integer', minimum: 1, maximum: 20 },
            description: '只想要这些节次都空着的教室，例如 [5,6,7,8] 表示下午 5-8 节',
          },
          roomTypeIds: {
            type: 'array',
            items: { type: 'string' },
            description: '教室类型：1=普通教室 2=多媒体教室（默认就查这两类）5=实验室',
          },
          limit: { type: 'integer', minimum: 1, maximum: 200, description: '最多列几间，默认 12' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_notice',
      description:
        '搜学校通知公告（教务处 + 门户资讯）。用户问「最近有什么通知」「有比赛吗」「关于XX的公告」时用。' +
        '会做同义词扩展（比赛→竞赛/大赛/挑战杯/创新创业/选拔/报名）。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '用户说的话里的关键词，原词即可（「比赛」「重修」「选课」），不要自己造句。留空=看最近的通知。',
          },
          days: { type: 'integer', minimum: 1, maximum: 365, description: '只看最近 N 天发布的' },
          limit: { type: 'integer', minimum: 1, maximum: 50, description: '最多几条，默认 10' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_grades',
      description:
        '查成绩与绩点。可按课程名过滤（用户问「高数多少分」「哪门拉低了绩点」时把课名填进 course）。' +
        '返回分数、学分、绩点，以及服务端给出的构成分（平时/期中/期末/卷面，不同课字段不同，没有就不显示）。',
      parameters: {
        type: 'object',
        properties: {
          course: { type: 'string', description: '课程名或其中一段，例如 高数 / 线性代数 / 英语。不填=全部' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_exams',
      description: '查考试安排（时间、地点、座位号）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_plan_progress',
      description: '查培养方案完成情况：总学分要求、已通过、在修、还差多少，以及各模块缺口与未修课程。',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '培养类型 code，默认 01（主修）' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_card',
      description: '查校园一卡通：余额、最近消费/充值流水。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_todos',
      description: '查待办事项：待办/在办/待申请计数与具体条目。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'library_seats',
      description:
        '查图书馆**实时空座数**（各馆空闲/总数，免登录）。用户问「图书馆还有位置吗」「自习去哪坐」「几楼有空位」时用。' +
        '只能给余量和入口：具体座位图与下单要学号+密码登录，你不能代替预约，也不要编造座位号。',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: '日期 YYYY-MM-DD；不填=今天。用户说今天/明天时**不要填**，让服务端按相对日期算。' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_service',
      description:
        '给出学校某个在线服务的入口（面板会渲染成可点按钮）：座位预约、网上办事大厅、图书馆、智慧食堂、报修、云盘、校历…' +
        '用户想「去某处办事/预约/查」但这件事没有对应工具时用它。注意：它只给入口，**不能代替用户完成预约**。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '服务名或口语说法，例如 座位预约 / 报修 / 奖学金 / 图书馆' },
        },
        required: ['keyword'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'export_ics',
      description: '把整学期课表导出成 iCalendar（.ics），可导入手机日历。',
      parameters: {
        type: 'object',
        properties: {
          fromWeek: { type: 'integer', minimum: 1, maximum: 30, description: '从第几周开始' },
          toWeek: { type: 'integer', minimum: 1, maximum: 30, description: '到第几周结束' },
        },
        additionalProperties: false,
      },
    },
  },
];

/** 只保留 TOOLS 里真实存在的工具（防止规格文件里写了不存在的名字）。 */
export function activeToolSpecs(): ToolSpec[] {
  return TOOL_SPECS.filter((s) => s.function.name in TOOLS);
}
