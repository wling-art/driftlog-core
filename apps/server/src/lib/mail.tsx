import { Resend } from "resend"
import { Body, Container, Head, Html, Link, Preview, Text } from "@react-email/components"
import { env } from "../env"

const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null

function CommentMail({
  title,
  author,
  body,
  url,
  reply,
}: {
  title: string
  author: string
  body: string
  url: string
  reply: boolean
}) {
  return (
    <Html lang="zh-CN">
      <Head />
      <Preview>{`${author}：${body.slice(0, 60)}`}</Preview>
      <Body style={{ background: "#CFD3D7", fontFamily: "system-ui, sans-serif", color: "#373737" }}>
        <Container
          style={{ background: "#E1E4E7", border: "1px solid #9A9EA3", borderRadius: 4, padding: 24 }}
        >
          <Text style={{ fontSize: 14, color: "#54575A" }}>
            {reply ? `${author} 回复了你在「${title}」下的评论` : `「${title}」有新评论`}
          </Text>
          <Text style={{ fontSize: 16, whiteSpace: "pre-wrap" }}>{body}</Text>
          <Link href={url} style={{ color: "#255E65", textDecoration: "underline" }}>
            去看看
          </Link>
        </Container>
      </Body>
    </Html>
  )
}

/** 没配 Resend 时不发，返回 false */
export async function sendCommentMail(to: string, props: Parameters<typeof CommentMail>[0]) {
  if (!resend) return false
  const { error } = await resend.emails.send({
    from: env.MAIL_FROM,
    to,
    subject: props.reply ? `${props.author} 回复了你` : `新评论：${props.title}`,
    react: <CommentMail {...props} />,
  })
  if (error) throw new Error(error.message)
  return true
}
