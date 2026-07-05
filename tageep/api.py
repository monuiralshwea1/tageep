import base64
import hashlib
import hmac
import json
import secrets
from datetime import datetime, timedelta

import frappe
from frappe import _
from frappe.utils import now_datetime


STATE_DOCTYPE = "Tageep App State"
STATE_NAME = "main"
TOKEN_TTL_HOURS = 12


def _table_name():
	if frappe.db.db_type == "postgres":
		return '"tabTageep App State"'

	return "`tabTageep App State`"


def _default_allowed_tabs():
	return {
		"main": True,
		"daily": True,
		"archive": True,
		"employees": True,
		"branches": True,
		"users": True,
		"settings": True,
	}


def _default_tab_permissions():
	return {
		"main": "all",
		"daily": "all",
		"archive": "all",
		"employees": "all",
		"branches": "all",
		"users": "all",
		"settings": "all",
	}


def default_state():
	# MODIFIED: Originally `workShifts` was not part of the persisted state here.
	# Added `workShifts` so shifts and their periods are saved/loaded via the API like other lists.
	return {
		"settings": {"companyName": "الشركة", "logo": "", "weeklyOffDays": ["5"]},
		"branches": [{"id": "b1", "branchNumber": "1", "name": "المركز الرئيسي", "address": ""}],
		"users": [
			{
				"id": "u-admin",
				"name": "admin",
				"password": "admin",
				"role": "admin",
				"branchId": "all",
				"allowedTabs": _default_allowed_tabs(),
				"tabPermissions": _default_tab_permissions(),
			}
		],
		"employees": [],
		"workShifts": [],
		"absences": [],
		"dailyFollowUps": [],
		"dailyExtras": [],
		# تعديل جديد: حفظ السلف اليومية ضمن حالة التطبيق.
		# الكود الأصلي لم يكن يحتوي على قائمة dailyAdvances.
		"dailyAdvances": [],
		"archivedReports": [],
		"sentReports": [],
		"holidays": [],
	}


def ensure_table():
	if frappe.db.table_exists(STATE_DOCTYPE, cached=False):
		return

	frappe.db.multisql(
		{
			"mariadb": """
				CREATE TABLE IF NOT EXISTS `tabTageep App State` (
					`name` varchar(140) NOT NULL,
					`state_json` longtext NOT NULL,
					`license_active` int(1) NOT NULL DEFAULT 1,
					`license_code_hash` varchar(128) DEFAULT NULL,
					`license_activated_at` datetime(6) DEFAULT NULL,
					`modified` datetime(6) DEFAULT NULL,
					PRIMARY KEY (`name`)
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
			""",
			"postgres": """
				CREATE TABLE IF NOT EXISTS "tabTageep App State" (
					"name" varchar(140) PRIMARY KEY,
					"state_json" text NOT NULL,
					"license_active" smallint NOT NULL DEFAULT 1,
					"license_code_hash" varchar(128),
					"license_activated_at" timestamp,
					"modified" timestamp
				)
			""",
		}
	)


def ensure_state_row():
	ensure_table()
	row_exists = frappe.db.sql(f"select name from {_table_name()} where name=%s", (STATE_NAME,))
	if row_exists:
		return

	state_json = json.dumps(default_state(), ensure_ascii=False)
	frappe.db.sql(
		f"""
			insert into {_table_name()} (name, state_json, license_active, modified)
			values (%s, %s, %s, %s)
		""",
		(STATE_NAME, state_json, 1, now_datetime()),
	)
	frappe.db.commit()


def _load_state_record():
	ensure_state_row()
	row = frappe.db.sql(
		f"""
			select state_json, license_active, license_code_hash, license_activated_at
			from {_table_name()}
			where name=%s
		""",
		(STATE_NAME,),
		as_dict=True,
	)
	return row[0]


def _restore_admin_password_if_all_empty(users):
	if not isinstance(users, list) or not users:
		return users

	for user in users:
		uid = str(user.get("id", "")).strip().lower().replace("_", "-")
		uname = str(user.get("name", "")).strip().lower()
		if uid == "u-admin" or uname == "admin" or user.get("role") == "admin":
			if not str(user.get("password", "")).strip():
				user["password"] = "admin"

	return users


def _normalize_state(state):
	if not isinstance(state, dict):
		state = {}

	clean = default_state()
	for key in clean:
		if key in state and state[key] is not None:
			clean[key] = state[key]

	clean["settings"] = clean.get("settings") or default_state()["settings"]
	clean["branches"] = clean.get("branches") or default_state()["branches"]
	clean["users"] = _restore_admin_password_if_all_empty(clean.get("users") or default_state()["users"])

	# Ensure lists exist. Added `workShifts`, `sentReports`, and `dailyAdvances`
	# so saved state will accept and normalize them.
	for list_key in (
		"branches",
		"users",
		"employees",
		"workShifts",
		"absences",
		"dailyFollowUps",
		"dailyExtras",
		# تعديل جديد: قبول قائمة السلف عند حفظ/تحميل حالة التطبيق.
		# الكود الأصلي معطل: لم تكن dailyAdvances ضمن القوائم المحفوظة.
		"dailyAdvances",
		"archivedReports",
		"holidays",
		"sentReports",
	):
		if not isinstance(clean.get(list_key), list):
			clean[list_key] = []

	if not clean["branches"]:
		clean["branches"] = default_state()["branches"]
	if not clean["users"]:
		clean["users"] = default_state()["users"]

	return clean


def _all_users_without_password(users):
	return all(not str(user.get("password", "")).strip() for user in users)


def _get_state():
	record = _load_state_record()
	try:
		return _normalize_state(json.loads(record.state_json or "{}"))
	except Exception:
		return default_state()


def _save_state(state):
	state = _normalize_state(state)
	frappe.db.sql(
		f"update {_table_name()} set state_json=%s, modified=%s where name=%s",
		(json.dumps(state, ensure_ascii=False), now_datetime(), STATE_NAME),
	)
	frappe.db.commit()
	# بعد حفظ الحالة كـ JSON، نزامن قوائم الموظفين والنوبات إلى جداول منفصلة في قاعدة فرابي
	try:
		_sync_state_to_tables(state)
	except Exception:
		frappe.logger().error("Tageep: Failed to sync state to tables", exc_info=True)
	return state


def ensure_employees_table():
	if frappe.db.table_exists("Tageep Employee", cached=False):
		return

	frappe.db.multisql(
		{
			"mariadb": """
				CREATE TABLE IF NOT EXISTS `tabTageep Employee` (
					`name` varchar(140) NOT NULL,
					`employee_json` longtext NOT NULL,
					`modified` datetime(6) DEFAULT NULL,
					PRIMARY KEY (`name`)
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
			""",
			"postgres": """
				CREATE TABLE IF NOT EXISTS "tabTageep Employee" (
					"name" varchar(140) PRIMARY KEY,
					"employee_json" text NOT NULL,
					"modified" timestamp
				)
			""",
		}
	)


def ensure_workshifts_table():
	if frappe.db.table_exists("Tageep Work Shift", cached=False):
		return

	frappe.db.multisql(
		{
			"mariadb": """
				CREATE TABLE IF NOT EXISTS `tabTageep Work Shift` (
					`name` varchar(140) NOT NULL,
					`shift_json` longtext NOT NULL,
					`modified` datetime(6) DEFAULT NULL,
					PRIMARY KEY (`name`)
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
			""",
			"postgres": """
				CREATE TABLE IF NOT EXISTS "tabTageep Work Shift" (
					"name" varchar(140) PRIMARY KEY,
					"shift_json" text NOT NULL,
					"modified" timestamp
				)
			""",
		}
	)


def _sync_employees(state):
	ensure_employees_table()
	ems = state.get("employees") or []
	for emp in emps:
		# استخدم الحقل id كـ اسم الصف، أو اسم إذا لم يوجد
		ename = (emp.get("id") or emp.get("name") or secrets.token_urlsafe(8)).strip()
		emp_json = json.dumps(emp, ensure_ascii=False)
		now = now_datetime()
		# ادراج أو تحديث
		mariadb_sql = (
			"INSERT INTO `tabTageep Employee` (name, employee_json, modified) VALUES (%s, %s, %s) "
			"ON DUPLICATE KEY UPDATE employee_json=%s, modified=%s"
		)
		postgres_sql = (
			"INSERT INTO \"tabTageep Employee\" (name, employee_json, modified) VALUES (%s, %s, %s) "
			"ON CONFLICT (name) DO UPDATE SET employee_json = EXCLUDED.employee_json, modified = EXCLUDED.modified"
		)
		params = (ename, emp_json, now, emp_json, now)
		frappe.db.multisql({"mariadb": mariadb_sql, "postgres": postgres_sql}, params)


def _sync_workshifts(state):
	ensure_workshifts_table()
	shifts = state.get("workShifts") or []
	for shift in shifts:
		# استخدم id أو اسم
		name = (shift.get("id") or shift.get("name") or secrets.token_urlsafe(8)).strip()
		shift_json = json.dumps(shift, ensure_ascii=False)
		now = now_datetime()
		mariadb_sql = (
			"INSERT INTO `tabTageep Work Shift` (name, shift_json, modified) VALUES (%s, %s, %s) "
			"ON DUPLICATE KEY UPDATE shift_json=%s, modified=%s"
		)
		postgres_sql = (
			"INSERT INTO \"tabTageep Work Shift\" (name, shift_json, modified) VALUES (%s, %s, %s) "
			"ON CONFLICT (name) DO UPDATE SET shift_json = EXCLUDED.shift_json, modified = EXCLUDED.modified"
		)
		params = (name, shift_json, now, shift_json, now)
		frappe.db.multisql({"mariadb": mariadb_sql, "postgres": postgres_sql}, params)


def _sync_state_to_tables(state):
	# تأكد من وجود الجداول ثم قم بالمزامنة
	ensure_employees_table()
	ensure_workshifts_table()
	_sync_employees(state)
	_sync_workshifts(state)


def _request_json():
	request = getattr(frappe.local, "request", None)
	if request:
		data = request.get_json(silent=True)
		if isinstance(data, dict):
			return data
		raw = request.get_data(as_text=True)
		if raw:
			try:
				parsed = json.loads(raw)
				if isinstance(parsed, dict):
					return parsed
			except ValueError:
				frappe.logger().error(f"Tageep: Failed to parse JSON body: {raw[:200]}")
	
	return {}


def _get_payload_value(key, default=None):
	# Try JSON body first (for application/json requests from frontend)
	for data in [frappe.form_dict, _request_json()]:
		if isinstance(data, dict) and key in data:
			return data.get(key)
	return default


def _b64encode(data):
	return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _b64decode(data):
	padding = "=" * (-len(data) % 4)
	return base64.urlsafe_b64decode((data + padding).encode())


def _token_secret():
	secret = frappe.conf.get("encryption_key") or frappe.conf.get("secret_key") or frappe.local.site
	return str(secret).encode()


def _sign(payload):
	return _b64encode(hmac.new(_token_secret(), payload.encode(), hashlib.sha256).digest())


def _make_token(user_id):
	payload = {
		"user_id": user_id,
		"exp": (datetime.utcnow() + timedelta(hours=TOKEN_TTL_HOURS)).isoformat(),
		"nonce": secrets.token_urlsafe(12),
	}
	payload_text = _b64encode(json.dumps(payload, separators=(",", ":")).encode())
	return f"{payload_text}.{_sign(payload_text)}"


def _parse_token(token):
	if not token or "." not in token:
		return None

	payload_text, signature = token.rsplit(".", 1)
	if not hmac.compare_digest(_sign(payload_text), signature):
		return None

	try:
		payload = json.loads(_b64decode(payload_text))
		expires_at = datetime.fromisoformat(payload.get("exp"))
	except Exception:
		return None

	if datetime.utcnow() > expires_at:
		return None

	return payload


def _request_token():
	# نحاول قراءة توكن Tageep من الهيدر المخصص أولاً.
	tageep_token = frappe.get_request_header("X-Tageep-Token")
	if tageep_token:
		return tageep_token.strip()

	# إذا لم يوجد الهيدر المخصص، نسمح أيضاً باستخدام Authorization Bearer.
	header = frappe.get_request_header("Authorization") or ""
	if header.lower().startswith("bearer "):
		return header[7:].strip()

	# كخيار أخير، نبحث في بيانات الطلب (body) عن access_token.
	return _get_payload_value("access_token")


def _current_tageep_user():
	# نتحقق من صحة التوكن ونفك الشيفرة لنحصل على هوية المستخدم.
	payload = _parse_token(_request_token())
	if not payload:
		frappe.local.response["http_status_code"] = 401
		frappe.throw(_("Invalid or expired Tageep session"), frappe.AuthenticationError)

	user_id = payload.get("user_id")
	user = next((item for item in _get_state().get("users", []) if item.get("id") == user_id), None)
	if not user:
		frappe.local.response["http_status_code"] = 401
		frappe.throw(_("Tageep user was not found"), frappe.AuthenticationError)

	return user


def _public_user(user):
	public = dict(user)
	public.pop("password", None)
	return public


@frappe.whitelist(allow_guest=True, methods=["GET"])
def license_status():
	record = _load_state_record()
	return {
		"active": bool(record.license_active),
		"message": "" if record.license_active else "يرجى تفعيل ترخيص النظام",
	}


@frappe.whitelist(allow_guest=True, methods=["POST"])
def activate_license(code=None):
	code = (code or _get_payload_value("code") or "").strip()
	if not code:
		frappe.local.response["http_status_code"] = 400
		frappe.throw(_("License code is required"), frappe.ValidationError)

	ensure_state_row()
	code_hash = hashlib.sha256(code.encode()).hexdigest()
	frappe.db.sql(
		f"""
			update {_table_name()}
			set license_active=%s, license_code_hash=%s, license_activated_at=%s, modified=%s
			where name=%s
		""",
		(1, code_hash, now_datetime(), now_datetime(), STATE_NAME),
	)
	frappe.db.commit()
	return license_status()


@frappe.whitelist(allow_guest=True, methods=["POST"])
def login(username=None, password=None):
	# نحصل على اسم المستخدم وكلمة المرور من المعاملات أو من جسم الطلب.
	username = (username or _get_payload_value("username") or "").strip()
	password = password if password is not None else _get_payload_value("password", "")

	if not username or password is None:
		frappe.local.response["http_status_code"] = 400
		frappe.throw(_("Username and password are required"), frappe.ValidationError)

	state = _get_state()
	users = state.get("users", [])
	# إذا كانت جميع كلمات المرور فارغة، نسمح بتسجيل الدخول كـ admin بكلمة admin.
	if _all_users_without_password(users) and username.lower() == "admin" and str(password) == "admin":
		user = next(
			(item for item in users if str(item.get("name", "")).strip().lower() == "admin"),
			None,
		)
	else:
		user = next(
			(
				item
				for item in users
				if str(item.get("name", "")).strip().lower() == username.lower()
				and str(item.get("password", "")) == str(password)
			),
			None,
		)

	if not user:
		frappe.local.response["http_status_code"] = 401
		frappe.throw(_("Invalid username or password"), frappe.AuthenticationError)

	# إذا نجح التحقق، نعيد توكن JWT مبني على HMAC ومعلومات المستخدم العامة.
	return {"access_token": _make_token(user.get("id")), "user": _public_user(user)}


@frappe.whitelist(allow_guest=True, methods=["GET"])
def get_state():
	_current_tageep_user()
	return _get_state()


@frappe.whitelist(allow_guest=True, methods=["POST"])
def save_state(state=None):
	user = _current_tageep_user()
	if user.get("role") != "admin":
		allowed_tabs = user.get("allowedTabs") or {}
		permissions = user.get("tabPermissions") or {}
		can_save = any(
			allowed_tabs.get(tab, True) and permissions.get(tab, "all") in ("all", "add", "edit", "delete")
			for tab in _default_allowed_tabs()
		)
		if not can_save:
			frappe.local.response["http_status_code"] = 403
			frappe.throw(_("You do not have permission to save Tageep data"), frappe.PermissionError)

	if state is None:
		state = _get_payload_value("state")
	if isinstance(state, str):
		state = frappe.parse_json(state)

	return _save_state(state)
