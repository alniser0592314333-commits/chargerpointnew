# تقرير التدقيق والإصلاح — منظومة إدارة الطلبات والعملاء

## النتيجة التنفيذية

تم تدقيق المشروع المرفق على مستوى:
- UI handlers ومسارات الإضافة/التعديل الأساسية.
- Domain rules وUse Cases.
- Transaction boundary.
- IndexedDB/local read model.
- Outbox + command identity + dependency scheduler.
- Supabase RPC contract.
- PostgreSQL migration/schema contract.
- pricing / charger-fee exemption / debt limit.
- order delivery/cancellation/payment allocation.
- backup snapshot / portable export / restore.
- customer identity/code normalization.
- device-type creation/update/reordering.
- remote change-log payloads.
- migration/bootstrap behavior.

التصميم البصري لم يتم تغييره.

> ملاحظة تحقق: تم إجراء فحص TypeScript ساكن بدون الاعتماديات، ونجح بلا أخطاء syntax/type جديدة في الملفات المعدلة. تشغيل Vitest/Vite كاملًا داخل بيئة العمل تعذر لأن الـZIP لا يحتوي node_modules وnpm لم يستطع تنزيل `vite-plugin-pwa` من الشبكة/الكاش. لذلك لا أدّعي اختبار اتصال Supabase الحقيقي أو الضغط على أزرار المتصفح فعليًا من داخل هذه البيئة.

## أهم الأخطاء التي تم العثور عليها

### 1. تسليم Order Item كان يستطيع استبدال أمر إضافة الجهاز
**السبب:** `DELIVER_ORDER_ITEM` كان يستخدم `item.id` كـcommandId، بينما `ADD_ORDER_ITEM` يستخدم نفس الـitem ID. الـIndexedDB outbox مفتاحه الأساسي `commandId`.

**النتيجة:** أمر الإضافة يمكن أن يُستبدل بأمر التسليم، ثم يصل للسيرفر بدون ترتيب صحيح.

**الإصلاح:** فصل Command Identity عن Aggregate/Entity Identity. التسليم والإلغاء يحصلان على UUID جديد، بينما `aggregateId` يبقى ID الجهاز/الطلب.

### 2. Delivery كان بلا dependency صريح على ADD_ORDER_ITEM
**السبب:** الـscheduler لم يعتبر `itemId/orderItemId` تبعية لـ`ADD_ORDER_ITEM`.

**الإصلاح:** التسليم/الإلغاء الآن ينتظران قبول أمر إضافة نفس الـitem قبل التنفيذ.

### 3. إنشاء الطلب كان غير ذري
**السبب:** التطبيق كان ينشئ Order في Transaction ثم يضيف الأجهزة في Transactions منفصلة.

**الخطر:** لو فشل جهاز واحد، يبقى CREATE_ORDER في الـoutbox وقد ينتج طلبًا ناقصًا.

**الإصلاح:** إضافة `createOrderWithItems()`؛ الطلب + كل الأجهزة + أوامر الـoutbox + القيود المالية الأولية أصبحت Transaction محلية واحدة.

### 4. Customer update لم يكن موحدًا
**السبب:** بعض مسارات التعديل كانت تحفظ العميل مباشرة بدل استخدام UPDATE_CUSTOMER canonical use case.

**الإصلاح:** تعديل العميل يمر الآن عبر `phase5UseCases.updateCustomer()`.

### 5. Customer code كان مختلفًا بين UI وPostgreSQL
**السبب:** الواجهة كانت تستخدم hash خاصًا، بينما PostgreSQL يستخدم أول 4 أحرف من UUID بعد إزالة الشرطات.

**الإصلاح:** UUID العملاء الجدد يستخدم نفس canonical code الموجود في PostgreSQL. السجلات legacy غير UUID لها fallback ثابت.

### 6. سقف الدين كان بإشارتين مختلفتين
**المشكلة:** DB canonical contract يتعامل مع `debt_limit_minor` كقيمة موجبة تمثل أقصى دين، بينما واجهة إضافة/تعديل العميل كانت تحفظ قيمة سالبة.

**الإصلاح:** البيانات الجديدة أصبحت تحفظ الحد كقيمة موجبة، مع استمرار منطق balance نفسه: الرصيد السالب = دين، الموجب = رصيد.

### 7. Device Type create كان يرسل عقدًا مختلفًا عن DB
**المشكلة:** الواجهة/Use Case كانا يرسلان `nameAr`, `nameEn`, `chargerFeeEnabled` بينما RPC كان يعتمد على `arabicName`, `englishName`, `chargerFeeApplicable`. كما أن `name_ar/name_en` إلزاميان في canonical schema.

**الإصلاح:** توحيد payload ليحتوي الحقول canonical ويُملأ `name_ar/name_en` دائمًا، مع إبقاء `charger_fee_enabled` و`charger_fee_applicable` متزامنين.

### 8. Device Type update كان يرسل/يسجل payload جزئيًا
**الخطر:** change_log كان يمكن أن يحتوي السعر فقط؛ وعند تطبيق delta على جهاز آخر كانت الحقول غير الموجودة تتحول إلى defaults وتضيع الاسم/الترتيب.

**الإصلاح:** UPDATE_DEVICE_TYPE يسجل الصف الكامل بعد التعديل، والـremote apply يقرأ الحقول canonical.

### 9. إدخال Device Type في رقم موجود لم يكن يحرك الأرقام
**الإصلاح:** إضافة جهاز في sortOrder موجود تحرك الأجهزة من ذلك الرقم وما بعده للأسفل داخل Transaction واحدة، وتُنشئ أوامر UPDATE لكل عنصر متأثر.

### 10. Order status كان يُعدل محليًا دون عقد server واضح
**الإصلاح:** إضافة `UPDATE_ORDER` server command، وتوحيد direct order saves بحيث تعديل الطلب يستخدم command جديد مستقل بدل إعادة استعمال CREATE_ORDER.

### 11. Delivery server لم يكن يضمن تحديث Order الأب
**الإصلاح:** عند تسليم آخر item فعال، PostgreSQL يغيّر Order إلى delivered ويسجل full canonical change للـOrder.

### 12. Server delivery لم يكن يفرض Debt Limit
**الإصلاح:** إضافة authoritative server-side debt-limit check عند recognition/delivery؛ فحص الواجهة أصبح UX فقط وليس مصدر الثقة المالية.

### 13. Server كان يسمح منطقيًا بإضافة item لطلب ملغى
**الإصلاح:** ADD_ORDER_ITEM يرفض الطلب الملغى، وDELIVER_ORDER_ITEM يرفض item/order الملغى.

### 14. CANCEL_ORDER لم يكن له implementation canonical في RPC
**الإصلاح:** إضافة تنفيذ كامل:
- إلغاء الطلب.
- إلغاء items الفعالة.
- عكس القيود المالية المعترف بها.
- تسجيل change_log كامل.
- منع تكرار reversal.

### 15. CANCEL_ORDER_ITEM لم يكن Transaction كاملًا محليًا
**الإصلاح:** item status + reversal ledger + outbox command أصبحت عملية ذرية.

### 16. Payment server لم يكن يضمن allocation الكامل
**الإصلاح:** POST_PAYMENT/CREATE_PAYMENT أصبح:
- ينشئ payment.
- يسجل PAYMENT ledger.
- يوزع المبلغ FIFO على order items المعترف بها.
- يحدث PAID/PARTIAL.
- يسجل payment_allocations في change_log.
- يحول المتبقي إلى credit adjustment.
- يحافظ على idempotency.

### 17. Remote change log كان أحيانًا يسجل payload الطلب بدل الصف الكامل
**الخطر:** جهاز آخر يستقبل UPDATE ناقصًا ويستبدل read model بصف ناقص.

**الإصلاح:** mutations الرئيسية تسجل `to_jsonb(full_row)` بعد mutation.

### 18. Remote bootstrap كان يعلن hydration ناجحًا حتى عند فشل الاتصال
**الإصلاح:** `initialHydrationCompleted` يُسجل فقط بعد نجاح full remote bootstrap.

### 19. Remote read model كان يمكن أن يبقى فيه stale local records
**الإصلاح:** full bootstrap هو authoritative snapshot في حالة fresh bootstrap؛ لا يتم التعامل مع partial remote response كأنه snapshot كامل.

### 20. UI notifications كانت يمكن أن تسبق commit الحقيقي لـIndexedDB
**الإصلاح:** `applyRemoteChange` يؤجل إشعار UI إلى transaction `complete` عندما تكون العملية ضمن IDB transaction فعلية.

### 21. Backup لم يكن يحفظ Outbox
**الخطر:** restore يعيد business data لكنه يفقد mutations التي لم تكن synced وقت أخذ النسخة.

**الإصلاح:** backup يحتوي الآن على:
- customers
- businessDays
- orders
- orderItems
- financialLedger
- payments
- paymentAllocations
- deviceTypes
- goals
- goalRequests
- qrTokens
- orderNumberReservations
- outbox
- syncState
- syncHistory

وعند restore يتم تنظيف الـoutbox القديم ثم إعادة الـoutbox الموجود في snapshot.

### 22. Backup restore كان يستطيع ترك outbox القديم في الذاكرة
**الإصلاح:** إضافة `clearOutboxWithTx()` لمسح memory + IndexedDB داخل نفس transaction.

### 23. QR persistent identity كان يمكن أن تضيع في backup بسبب sanitize العام
**الإصلاح:** backup يحافظ على `publicToken/public_token` و`tokenHash/token_hash` بدل الاعتماد على مفتاح raw `token`.

### 24. Goals وGoal Requests لم تكن ضمن business backup
**الإصلاح:** إضافتها إلى snapshot/export/restore/online backup/consolidated backup.

### 25. Close Day لم يكن له server command canonical
**الإصلاح:** إضافة CLOSE_DAY في RPC وRBAC وchange log.

### 26. CREATE_ORDER أصبح server-authoritative في رقم الطلب
العميل يستطيع اقتراح رقم محلي، لكن PostgreSQL يحدد الرقم النهائي تحت transaction lock حسب أعلى رقم لذلك اليوم + 1. هذا يمنع تعارض رقمين من جهازين.

### 27. stale migration artifact
تم حذف نسخة migration مكررة داخل `app/applet/supabase/migrations` حتى لا يكون هناك مسار SQL ثانٍ قديم يمكن أن يسبب التباسًا. المسار canonical هو `supabase/migrations`.

## عقد العمليات النهائي

### إضافة يوم
UI → createNewBusinessDay → dayRepo → local IndexedDB + OPEN_DAY outbox → SyncBridge → canonical RPC → business_days → change_log → delta pull.

### إضافة عميل
أي UI entry point → addNewCustomer → customerRepo/use case → customers + CREATE_CUSTOMER outbox → RPC → customers + change_log.

### إنشاء طلب
UI → createOrderWithItems → Transaction واحدة:
1. validate day
2. validate customer
3. validate debt limit
4. validate every device
5. calculate historical prices
6. create order
7. create every item
8. create every outbox command
9. commit

بعد commit يبدأ sync في الخلفية.

### تسليم جهاز
UI → BIN → validate transition → local item update + delivery command UUID جديد → scheduler ينتظر ADD_ORDER_ITEM → RPC → authoritative debt check → financial ledger charge → item recognized → parent order delivered إذا انتهت كل items → change_log.

### الدفع
UI → payment use case → local payment + ledger + FIFO allocations + CREATE_PAYMENT outbox → RPC → authoritative payment + allocations + item statuses + overflow credit → change_log.

### Backup
Local snapshot الآن يمثل حالة التشغيل، وليس مجرد نسخ الجداول الرئيسية. الـoutbox وsync checkpoint محفوظان أيضًا، مع عدم تخزين raw BIN credentials.

## الملفات التي تم تعديلها

- `src/application/useCases.ts`
- `src/components/pages/AddOrderPage.tsx`
- `src/components/pages/CustomerDetailPage.tsx`
- `src/components/pages/dayOrdersStore.ts`
- `src/infrastructure/localDb/localDb.ts`
- `src/infrastructure/sync/outboxScheduler.ts`
- `src/infrastructure/sync/syncEngine.ts`
- `src/services/backup/backupService.ts`
- `supabase/migrations/00112_final_canonical_business_contract.sql`

## التحقق

- تم فحص الملفات المعدلة باستخدام TypeScript compiler في وضع parsing/type analysis بدون الاعتماديات الخارجية.
- لا توجد أخطاء syntax أو type errors جديدة في الملفات المعدلة بعد استبعاد أخطاء البيئة الناتجة عن غياب node_modules.
- المشروع الأصلي كان يحتوي test artifact سابقًا يذكر 757 اختبارًا: 724 ناجحًا و33 فاشلًا؛ هذا artifact كان stale وتم حذفه من النسخة النهائية حتى لا يمثل نتيجة تشغيل جديدة كاذبة.
- تشغيل Vitest/Vite كاملًا لم يكن ممكنًا لأن الاعتماديات غير موجودة في الـZIP و`npm ci --offline` توقف عند dependency غير موجودة في npm cache، بينما محاولة التثبيت الشبكي تجاوزت مهلة البيئة.

## ملاحظة تشغيلية مهمة

لا يمكن من ZIP وحده إثبات أن PostgreSQL/Supabase الموجود عندك فعليًا طبّق migration 00112؛ يجب تشغيل migrations على مشروع Supabase المستهدف. كذلك لا يمكن من هذه البيئة إثبات network/RLS/auth behavior ضد قاعدة بياناتك الحية.

النسخة المسلّمة تحتوي الإصلاحات البرمجية وmigration النهائية، ولا تحتوي تغييرًا على التصميم العام.
