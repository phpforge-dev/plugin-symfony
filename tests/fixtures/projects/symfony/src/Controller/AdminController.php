<?php

namespace App\Controller;

use App\Entity\Post;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\DependencyInjection\ContainerInterface;
use Symfony\Contracts\Translation\TranslatorInterface;

final class AdminController
{
    public function dashboard(EntityManagerInterface $em, TranslatorInterface $translator, ContainerInterface $container): array
    {
        $posts = $em->getRepository(Post::class)->findBy(['author' => null]);
        $query = $em->createQuery('SELECT p FROM App\Entity\Post p JOIN p.author u WHERE u.email = :e AND p.title = :t');
        $router = $container->get('router');
        return [
            $translator->trans('admin.title'),
            $translator->trans('menu.posts', [], 'admin'),
            $translator->trans('missing.key'),
        ];
    }
}
